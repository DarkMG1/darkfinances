# Runtime state contracts

`lib/state-registry.js` is the authoritative inventory for dashboard runtime JSON sidecars: schema version, durability, backup membership, reference domains, unknown-field policy, optional-missing semantics, and migration ownership.

Reads and writes go through `lib/runtime-state-store.js`, which applies `lib/runtime-state-schemas.js` and `lib/runtime-state-field-policy.js` in this order:

1. Parse primary JSON or classify `ENOENT` as **missing optional** vs **missing default**.
2. On syntax corruption, quarantine the primary file and recover only from a validated `.last-good` when the registry entry allows it.
3. Run idempotent migrations for supported legacy shapes **before** current-schema validation.
4. Enforce declared **unknown-field policy** after migration consumes known legacy keys (`lib/runtime-state-field-policy.js`).
5. Apply caller invariants and semantic validation (`lib/runtime-state-semantics.js`).
6. Reject future `schemaVersion` values and malformed current shapes without overwriting evidence with defaults.

Writes validate the current schema, enforce unknown-field policy on the normalized payload, apply **strict write semantics** for journal/saga families, refuse schema downgrade, and are blocked after an invalid primary read unless recovery succeeded from `.last-good`.

## Unknown-field policy

| Policy | Behavior |
|---|---|
| `reject` (default) | Envelope stores reject undeclared top-level keys after migration; open-map stores reject misplaced reserved keys such as `schemaVersion`. |
| `preserve-top-level` | Declared envelope keys plus undeclared top-level metadata round-trip losslessly through read/write/backup validation. |

Open-map stores (`billsPaid`, `budgetSettings`, `owesConfig`, `personalConfig`, `recurringOverrides`) treat domain keys as the payload. Array-root stores (`goals`, `passkeyCredentials`) have no object top-level keys.

## Read vs write semantics

**Read** remains legacy-tolerant for journal/saga sidecars: partial fault checkpoints and legacy records without full identity may load when envelope shape validates.

**Write** for journal/saga families rejects incomplete **new** records (missing durable `id`/`phase`/`updatedAt`, or family-required fields). An existing on-disk record supplies prior evidence and may be rewritten without upgrading identity until a production factory checkpoint supplies full identity. Terminal saga pruning and ownership-not-weakened guards remain unchanged.

## `.last-good` policy

Entries with `lastGoodPolicy: allow-on-primary-invalid` may serve reads from `*.last-good` after the primary is quarantined. The corrupt primary remains on disk (plus a `*.corrupt-*` copy when possible). Entries with `lastGoodPolicy: never` fail closed when the primary is invalid.

## Passkey credentials

`passkeyCredentials` is registered for backup/inventory alignment but uses durability contract `passkey-server-writer`. `server.js` remains the sole writer via `lib/passkey-credentials-store.js`, which validates against the same runtime schema and persists a canonical bare array with `0600` atomic rename (no `.last-good`).

Reads normalize through the authoritative schema and `lib/passkey-credentials-schema.js` entry validation (required `credentialID`, `credentialPublicKey`, non-negative integer `counter`; optional `transports`/`createdAt`/`lastUsedAt`):

- **Missing file (`ENOENT`)** → empty array `[]` (valid unregistered enrollment state).
- **Bare array** → load unchanged when every entry validates.
- **Documented `{ credentials: [...] }` wrapper** → unwrap losslessly in memory; writer re-canonicalizes to bare array on save.
- **JSON literal `null`, malformed roots, or nonfunctional entries such as `[{}]`** → fail closed (never treated as missing/unregistered).

Production reads use `readRuntimeState('passkeyCredentials', { file })` so quarantine/write-guard behavior matches the runtime store. External writes call `assertWritable(file)` before the atomic bare-array save.

`lastGoodPolicy: never` — corrupt primaries are not recovered from sidecars.

Optional JSON `null` is valid only for documented optional sidecars (`personalConfig`, `owesConfig`, `owesTruth`, `venmoTruth`). Passkey is the explicit security exception.

## Saga stores

Journal and saga sidecars preserve active ownership during migration: non-terminal records cannot be terminalized and terminal proof cannot be fabricated by migration alone. Direct writes cannot weaken ownership, drop nonterminal sagas, or strip journal fingerprints/terminal proof.

PR-16 provides a versioned, relocatable dashboard runtime backup bundle with embedded verification tooling. The committed `ops/lib/backup-state-inventory.json` snapshot is generated deterministically from this registry and parity-enforced in tests.

`finance-dashboard/test/backup-registry-parity.test.js` asserts exact parity between:

- `STATE_REGISTRY` entries with `backup: true` (via `backupEntries()`)
- `ops/lib/backup-state-inventory.json` (via `sidecarFilenames()`)
- `ops/lib/backup-verify.js` `SIDECAR_FILES`
- runtime members derived by `ops/lib/list-backup-runtime-members.js`

The backup scripts also archive the `receipts/` directory when present and eligible `.last-good` sidecars for registry entries with `lastGoodPolicy: allow-on-primary-invalid`. Quarantine copies (`*.corrupt-*`) and environment files are excluded.

Relocatable bundles (`darkfinances-dashboard-runtime-backup-bundle`, schema v1) embed runtime payloads under `runtime/`, verification tooling under `tooling/`, and a sidecar `bundle-manifest.json` with artifact identity, provenance, per-file digests/modes, runtime-state inventory metadata, and required restore tooling identity. Verify with `ops/bin/verify-backup-bundle.sh` on any host with Node 24+ and `tar`; no repository checkout is required. PR-17 owns staged live swap/generation-bound restore; PR-18 owns writer quiescence.

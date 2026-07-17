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

`passkeyCredentials` is registered for backup/inventory alignment but uses durability contract `passkey-server-writer`. `server.js` remains the sole writer; the runtime store rejects direct writes so the registry does not claim `.last-good` durability that the server writer does not provide.

## Saga stores

Journal and saga sidecars preserve active ownership during migration: non-terminal records cannot be terminalized and terminal proof cannot be fabricated by migration alone. Direct writes cannot weaken ownership, drop nonterminal sagas, or strip journal fingerprints/terminal proof.

PR-16 owns backup bundle redesign; this document only records contracts consumed by backup verification. The backup script sidecar list in `ops/lib/backup-verify.js` remains hardcoded.

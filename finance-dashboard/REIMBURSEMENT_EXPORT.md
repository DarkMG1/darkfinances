# Reimbursement export (PR-26)

Every reimbursement export/report uses one shared allocation-ledger projection sourced from
authoritative reimbursement links (`allocationCents`), live endpoint snapshots, link versions,
legacy ambiguity reports, and operational saga state. Exports never re-infer full expense
amounts or category totals from heuristics.

## Surfaces

| Surface | Entry |
|---------|--------|
| Dashboard / app API | `GET /api/v1/reimbursement-export?format=json\|csv\|human` |
| CLI | `actual-tools/reimb-report.js` (`--json`, `--csv`, `--strict`, `--output`) |
| Ledger view | `getReimbursementLedger` trusted allocations via `buildTrustedAllocationIndex` |

Query params: `from`, `to` (optional date window on link endpoints), `strict=1` (fail before
publish when incomplete).

## Schema

- `schemaVersion`: 1
- `allocationPolicyVersion`: `pr25-explicit-v1`
- Integer cents throughout; authoritative totals are `null` when `completeness.status` is
  `incomplete`
- **Dual scopes**: `scopes.global` (all links) and `scopes.window` (both inflow and expense
  dates must fall inside the requested window). Window totals stay separate from global
  remaining/allocated cents.
- Provenance: `generatedAt`, finance timezone, release identity, Actual generation,
  links-sidecar digest, links revision, sidecar snapshot digest, live-endpoint identity digests

## Endpoint fingerprints

- **Stored identity fingerprint** (`storedEndpointIdentityFingerprint`) binds each link endpoint
  to the transaction id, date, amount, and payee observed when the link was written.
- **Live identity fingerprint** (`liveEndpointIdentityFingerprint`) is computed from the current
  Actual snapshot (includes reimbursement category eligibility).
- **Admission fingerprint** remains for link admission only; export completeness uses identity
  mismatch (not admission mismatch) so categorized reimbursement endpoints do not false-positive
  as incomplete.

## Completeness

Incomplete reasons include legacy ambiguous links, orphaned/moved endpoints, identity mismatch,
reimbursement category ineligibility, active reimbursement link sagas, incomplete ledger scans,
and endpoint over-allocation. Each reason is listed in `completeness.reasons` with supporting
`incompleteSections`. Subsidiary authoritative numbers are withheld (`null`) when incomplete.

## Concurrency and snapshot integrity

Export capture binds to one Actual coordinator generation and one links-sidecar revision:

1. Acquire a cross-process `reimb-export.lock` beside the links sidecar (revision-bound, PID
   stamped, stale locks removed when the owning process is dead).
2. Record a sidecar snapshot digest (links revision, sorted links, nonterminal sagas).
3. Read Actual under the coordinator generation barrier.
4. Re-read the sidecar and assert the snapshot digest is unchanged.
5. Retry up to `MAX_SNAPSHOT_ATTEMPTS` (4) on `ExportSourceChangedError`; exhaustion surfaces
   `EXPORT_SOURCE_CHANGED`.

Link writes increment sidecar `revision` and refuse while an export lock is held.

## Bounds and publish safety

- `MAX_EXPORT_LINKS`, `MAX_EXPORT_WINDOW_SPAN_DAYS`, `MAX_EXPORT_FIELD_LENGTH`, and
  `MAX_EXPORT_SERIALIZED_BYTES` fail closed with `REIMBURSEMENT_EXPORT_BOUNDS`.
- `prepareExportForPublish` enforces conservation per scope, sanitizes/redacts output, and
  rejects strict incomplete exports before any artifact is written.
- JSON sidecars and CLI `--output` use `writePrivateFileAtomic` (symlink/hardlink-safe, fsync,
  private mode).

## CLI exit codes

| Code | Meaning |
|------|---------|
| 0 | Complete export |
| 2 | Incomplete / ambiguous export published (non-strict) |
| 1 | Operational failure (including strict incomplete) |

`--output` writes atomically; failed strict exports leave no partial artifact.

## CSV safety

Formula-prefix cells are escaped; commas, quotes, and newlines are RFC-safe. Field values are
truncated and stripped of ANSI, bidi, and control characters. Secret-like keys are redacted
recursively. No receipt bytes or credentials are included.

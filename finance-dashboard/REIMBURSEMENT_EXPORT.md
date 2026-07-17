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
- Provenance: `generatedAt`, finance timezone, release identity, Actual generation,
  links-sidecar digest, live-endpoint digest

## Completeness

Incomplete reasons include legacy ambiguous links, orphaned/moved endpoints, fingerprint mismatch,
active reimbursement link sagas, incomplete ledger scans, and endpoint over-allocation. Each
reason is listed in `completeness.reasons` with supporting `incompleteSections`.

## Concurrency

Export capture binds to one Actual coordinator generation. Concurrent link mutation during export
retries a bounded snapshot (`MAX_SNAPSHOT_ATTEMPTS`); exhaustion raises `EXPORT_SOURCE_CHANGED`.

## CLI exit codes

| Code | Meaning |
|------|---------|
| 0 | Complete export |
| 2 | Incomplete / ambiguous export published (non-strict) |
| 1 | Operational failure (including strict incomplete) |

`--output` writes atomically; failed strict exports leave no partial artifact.

## CSV safety

Formula-prefix cells are escaped; commas, quotes, and newlines are RFC-safe. No receipt bytes or
secrets are included.

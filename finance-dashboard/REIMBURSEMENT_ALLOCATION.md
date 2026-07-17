# Reimbursement allocation (PR-25)

Manual reimbursement links require explicit integer-cent allocations. The server resolves live
Actual transaction ids, signs, and capacities; client snapshots are hints only.

## Contract

- `POST /api/v1/reimb-links` requires `allocationCents` (preferred) or strict-boundary `amount`.
- Capacity is enforced on both the inflow and expense sides under one atomic sidecar write.
- Legacy links with `amount: null` remain read-only, appear in `legacyReport`, and are excluded
  from trusted totals/completeness.
- Updates require `expectedVersion` when changing an existing explicit allocation.
- Link/unlink mutations run through `reimbursement-link-sagas.json` for crash convergence and
  operation-journal idempotency.

## Reads

`GET /api/v1/reimb-links?id=<txnId>` returns linked endpoints with `allocatedCents`,
`allocationTrusted`, `allocationAmbiguous`, and `capacity.remainingTrustedCents` from one
authoritative projection.

## Migration

`reimb-links.json` schemaVersion 2 adds `allocationCents`, `linkKey`, and `version` on explicit
links. Null-amount legacy rows are preserved without guessed cents. Use `legacyReport` for manual
resolution.

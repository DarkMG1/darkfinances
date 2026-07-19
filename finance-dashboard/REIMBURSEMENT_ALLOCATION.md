# Reimbursement allocation (PR-25)

Manual reimbursement links require explicit integer-cent allocations. The server resolves live
Actual transaction ids, signs, and capacities; client snapshots are hints only.

## Contract

- `POST /api/v1/reimb-links` requires `allocationCents` (preferred) or strict-boundary `amount`.
- Capacity is enforced on both the inflow and expense sides under one atomic sidecar write.
- Legacy links with `amount: null` remain read-only, appear in `legacyReport`, and are excluded
  from trusted totals/completeness.
- Updates require `expectedVersion` when changing an existing explicit allocation.
- Link/unlink mutations run through `reimbursement-link-sagas.json` for crash convergence,
  journal terminal proof keyed by the same idempotency key, and operation-journal idempotency.
  The saga store uses authoritative runtime-state semantics with bounded terminal pruning
  (100 records).

## Reads

`GET /api/v1/reimb-links?id=<txnId>` returns linked endpoints with `allocatedCents`,
`allocationTrusted`, `allocationAmbiguous`, and `capacity.remainingTrustedCents` from one
authoritative projection.

## Legacy ambiguity

Endpoints with legacy null/ambiguous links block **new** trusted allocations on any other
pair touching that endpoint (`REIMBURSEMENT_LEGACY_AMBIGUITY_BLOCKED`, 409). Explicit
same-pair upgrade/resolution and unlink are allowed when no other ambiguity remains on
either endpoint.

## Concurrency

Manual link admission and apply run under one Actual coordinator write scope. Apply
re-locates live endpoints, re-reads sidecar links, and revalidates sign/category/capacity
before write so concurrent links cannot exceed shared capacity.

## Operational saga health

Startup and sync recovery drive every operational saga family independently; one broken
record cannot block recovery of unrelated healthy sagas. `getHealth()` and `/api/v1/ping`
expose `operationalSagas` (nonterminal counts, recovery errors, readiness). The process
is not `ready` while any operational saga remains nonterminal or reported a recovery error
after the latest recovery pass.

## Field agreement

When both `allocationCents` and `amount` are sent, they must agree exactly (400).

## DELETE

Unlink accepts `expectedVersion` and journal `operationIdentity` for stale-version and
idempotent replay protection.

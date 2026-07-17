# Bulk operation safety contract

`bulk-operation-sagas.json` stores versioned checkpoint records for multi-item rule
application, rule-save auto-apply, and live phantom cleanup. Each record binds to an
operation idempotency key (when present), exact transaction ids, canonical identity
fingerprints (category intent stored separately), stable item order, intended effects,
and sidecar convergence plans.

## Phases

```
prepared → plan_checkpoint → items_pending → sidecars_pending → sync_pending → completed | unresolved
```

Per-item durability uses `item-{n}-pending-checkpoint` before effects and
`item-{n}-applied-checkpoint` after exact verification. Phantom deletes delegate to
`transaction-deletion-sagas.json` through an explicit per-item delegation token;
bulk retains ownership of the transaction id until a real deletion saga id is
durably checkpointed (never a `'pending'` sentinel). Restart discovers an in-flight
deletion saga by transaction id when the bulk record lacks the delegation id yet.
Once a deletion saga exists for the txn, delegation tokens are invalid.

## Ownership

Before plan admission, bulk rejects overlap with every other nonterminal bulk record
(excluding self) and with replacement, deletion, and repayment confirmation sagas.
Bulk records own transaction ids from item pending through completion; phantom seen
and delete resources stay owned through sidecar convergence until terminalization.
Only the current bulk item may authorize deletion via `activeDelegation`
`{ itemIndex, txnId, token, accountId }`.

## Outcomes and API status

- `completed`: every item converged, sidecars match intent, and sync terminalized
- `unresolved`: fingerprint/account/rule-sidecar ambiguity or incompatible drift
- `in_progress`: nonterminal bulk phase (including `sync_pending`)

`needsSync: true` means the saga reached `sync_pending` and awaits shared sync plus
terminal checkpoint. Callers must not report `ok: true` while nonterminal. Read-only
replay uses `getBulkOperationResult(operationKey)` after sync to return the terminal
result. When bulk recovery terminalizes while the operation journal remains nonterminal,
`proveBulkOperationJournalCompletion(operationKey)` supplies durable proof for journal
status-only reconciliation on `GET /api/v1/operations/:key` and same-key mutation replay.
The proof requires the existing journal record and exact equality of the saga's bound
`operationJournalFingerprint`, `operationJournalFingerprintVersion`, method, route, and
kind. Journal-backed bulk sagas persist that binding at initial admission before effects;
direct/internal bulk calls without a journal fingerprint never serve as journal terminal
proof. A retained terminal bulk tombstone rejects the same operation key with a different
request fingerprint even when the journal entry was pruned. Duplicate operation keys in
`bulk-operation-sagas.json` fail closed and never reconcile.

Generic/transient item errors remain pending with bounded `lastError`; they do not
become terminal partial outcomes. Rules sidecar convergence compares the full canonical
rules list fingerprint, not rule id alone.

Never report a terminal safe failure after any item checkpoint may have taken effect.
If a planned phantom delete target is absent without a proven delegation record or
completed deletion outcome, fail closed unresolved — never mark skipped merely because
the row disappeared.

## Recovery and sync

Startup recovery drives every nonterminal record with `deferSync`, performs at most
one shared Actual sync when any pending saga requires it, then terminalizes each
eligible saga independently. Sync failure leaves sagas in `sync_pending`; none are
falsely marked completed. Zero-item operations terminalize without Actual sync when no
Actual mutation occurred.

## Deployment and downgrade safety

Do not serve mutation traffic from a pre-PR-11 server while any nonterminal
`bulk-operation-sagas.json` record exists. That constraint is an explicit operator
contract; a new binary cannot enforce behavior of an older server after downgrade.
Restore generation-bound backups with matching Actual, deletion sagas, phantom
sidecars, and rules state.

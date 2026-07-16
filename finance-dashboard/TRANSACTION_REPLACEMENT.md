# Transaction replacement safety contract

`transaction-sagas.json` keeps outer `schemaVersion: 1` for rollback compatibility. New records use
`recordVersion: 2`. A nonterminal v2 record deliberately exposes legacy `status: "aborted"` so the
previous server skips its unsafe date/amount recovery; the v2 `phase` is authoritative.

The forward path durably records preparation, delete intent/result, replacement-add intent, the unique
temporary `imported_id` identity, Actual's returned parent/leg IDs, import-metadata restoration, each
reference-store write, and terminal completion. The temporary identity is removed before references
move, restoring the original `imported_id` (including `null` for manual transactions). Forward work
stays `sync_pending` until `syncNow()` succeeds; a sync or terminal-write failure therefore remains
nonterminal while PR-06 records `sync_unknown`.

Before admission, every saga whose authoritative v2 phase is not `completed` or `rolled_back` is
checked for overlapping original, replacement, restored, and legacy transaction IDs. A migrated
legacy `status` never releases that ownership before v2 reconciliation succeeds. Imported
transactions also require one unique live owner across the Actual account before deletion and again
before the saved `imported_id` is restored.

Rollback records replacement deletion, a separate restoration identity, restored parent/leg IDs,
replacement-and-original to restored ID mappings, each reference-store write, sync uncertainty, and
terminal `rolled_back`. Nonterminal records are never pruned; only the newest 100 terminal records are
retained.

Replacement reference migration preserves evidence. Removed legs map to the replacement parent,
retained legs map only to a uniquely proven generated successor, and receipts, reimbursement
snapshots/amounts, reconciliation, and phantom-seen values are retained while IDs change. Receipt
bytes are never removed by this workflow; transaction-deletion cleanup belongs to PR-09.
Reimbursement mappings are validated as one complete plan before the first sidecar write: endpoint
self-collapses and duplicate mapped link, suggestion, or allocation relationships fail closed and
enter the checkpointed rollback path without dropping or merging evidence.

Legacy records are migrated deterministically. A legacy record with an exact saved replacement or
restoration ID is revalidated and replayed by that ID. A record without sufficient durable identity
becomes `legacy_unresolved`; recovery performs no date/amount guess and no Actual or sidecar mutation.

## Deployment and rollback

Before deployment or rollback, drain mutation traffic, take a verified backup containing Actual state,
both journals, all reference sidecars, and receipt files, then inventory every v2 `phase`.

The previous server may serve mutations only when every saga is terminal (`completed` or `rolled_back`
under v2 semantics). Although it safely skips active v2 records, its all-record 100-entry pruning and
legacy writer cannot preserve them. If any saga is nonterminal, keep the new server or disable mutations
until the saga is reconciled. Never delete, relabel, or retry an unresolved operation with a new
idempotency key merely to permit rollback.

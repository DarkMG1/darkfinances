# Transaction deletion safety contract

`transaction-deletion-sagas.json` is independent from the replacement saga collection. Its outer
`schemaVersion` and record `recordVersion` are both `1`. The durable phases are:

`prepared` → `delete_pending` → `actual_deleted` → `references_pending` →
`references_deleted` → `sync_pending` → `receipt_cleanup_pending` → `completed`.

Before the first Actual mutation, the record contains the account and date, exact parent and leg IDs,
a canonical transaction snapshot and fingerprint, the exact-ID reference cleanup plan, validated
receipt filenames, and timestamps. `delete_pending` is the durable delete intent. Every recovery
verification enumerates all Actual accounts without filtering closed or off-budget accounts and queries
each account across the full date range. An absent parent is treated as an applied deletion only when
every checkpointed parent and leg ID is absent from every account. If any exact saved ID is found
outside the recorded account, or if enumeration or any account query fails, the saga remains
nonterminal and performs no deletion, reference rewrite, terminalization, or receipt cleanup.

A present unchanged parent in the recorded account may be retried. The canonical fingerprint retains
the date, so a saved ID moved to another date fails closed instead of being followed or deleted. A
present parent with a changed financial shape, or a surviving saved leg without its parent, also fails
closed. Deletion never re-adds or searches for a transaction by date, amount, payee, or other
approximate fields, and financial shape is never used to select a row in another account.

Reference cleanup is deletion-specific and checkpointed independently for receipts, reimbursement
links, reimbursement suggestions, reconciliation, and phantom-seen state. Only rows or allocation
entries that contain an exact deleted ID are removed. Unknown top-level fields and unrelated legacy or
null-endpoint rows are preserved. Reapplying any completed or uncheckpointed step is idempotent.

Receipt candidates come only from removed receipt records. A filename shared by surviving metadata is
not scheduled for deletion, and every candidate path is validated before the saga is written. Receipt
bytes remain in place through Actual deletion, reference cleanup, and successful Actual sync. Only a
durable `receipt_cleanup_pending` record permits unlinking. A missing planned file is a completed unlink,
which makes a crash after unlink and before its checkpoint replay-safe.

Nonterminal deletion and replacement records own every checkpointed parent and leg ID. Shared
admission blocks any transaction field change, replacement, deletion, or sidecar reference mutation for
an owned ID. Direct HTTP routes check globally unique known IDs before the operation effect boundary
without trusting client-supplied account scoping; internal and bulk callers recheck each discovered ID in
the data layer. Account-scoped checks are used only when the account was resolved from Actual. Terminal
records release ownership.
Nonterminal records are never pruned; only the newest 100 completed records are retained. Stored errors
are bounded and credential-redacted, and every completed record contains a durable `auditOutcome`.

Startup recovery resumes nonterminal deletion records. Normal and shutdown sync paths drive every
independent replacement and deletion saga before one shared sync. After a successful sync they
terminalize every eligible saga before surfacing a collected drive or terminalization error, so one
broken saga cannot strand healthy work. Sync failure leaves deletion at `sync_pending`. The operation
journal remains authoritative for HTTP replay: a request that may have crossed the delete boundary
returns `OUTCOME_UNKNOWN`, and the same idempotency key is status-only rather than automatically executed
again.

Backups and rollback must keep Actual state, both saga files, the operation journal, every reference
sidecar, and `receipts/` together. A server version that does not understand deletion sagas must not
serve mutation traffic while any deletion record is nonterminal.

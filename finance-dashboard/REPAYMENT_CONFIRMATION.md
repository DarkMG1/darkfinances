# Repayment confirmation safety contract

`repayment-confirmation-sagas.json` is independent from the replacement and deletion saga
collections. Its outer `schemaVersion` and record `recordVersion` are both `1`. The durable
phases are:

`prepared` → `category_pending` → `category_applied` → `links_pending` → `links_applied` →
`confirmation_pending` → `confirmation_applied` → `sync_pending` → `completed`.

Before the first effect, the record contains the suggestion id, optional operation identity,
inflow account and date, exact inflow and expense transaction ids, canonical integer cent
amounts, intended Reimbursement category id, person, allocation plan, per-endpoint account
mapping, canonical transaction snapshots and fingerprints, and timestamps. `category_pending`
is the durable categorization intent. Every recovery verification enumerates all Actual accounts
without filtering closed or off-budget accounts and queries each account across the full date
range. Each checkpointed id is verified only in its recorded account; the same id in another
account fails closed. Missing endpoints, changed financial shape, overlapping duplicate
allocations, or cent plans that exceed inflow or expense bounds remain nonterminal and perform
no further effects.

Category application uses an exact category id match. Reimbursement links and the suggestion
confirmation audit are checkpointed independently with per-allocation durability. Sidecar writes
preserve unknown top-level fields and unrelated rows. Reapplying any completed or uncheckpointed
step is idempotent. Conflicting link or confirmation amounts fail closed into outcome-unknown
rather than duplicating effects.

Nonterminal repayment confirmation records own every checkpointed inflow and expense id. Shared
admission blocks any transaction field change, replacement, deletion, category mutation, or
sidecar reference mutation for an owned id. Direct HTTP routes check globally unique known ids
before the operation effect boundary; internal callers recheck each discovered id in the data
layer. Terminal records release ownership.

Nonterminal records are never pruned; only the newest 100 completed records are retained. Stored
errors are bounded and credential-redacted, and every completed record contains a durable
`auditOutcome`.

Startup recovery and normal/shutdown sync paths drive every independent replacement, deletion,
and repayment confirmation saga before one shared sync. After a successful sync they terminalize
every eligible saga before surfacing a collected drive or terminalization error, so one broken
saga cannot strand healthy work. Sync failure leaves repayment confirmation at `sync_pending`.
The operation journal remains authoritative for HTTP replay: a request that may have crossed the
first-effect boundary returns `OUTCOME_UNKNOWN`, and the same idempotency key is status-only
rather than automatically executed again.

## Deployment and downgrade safety

Backups and rollback must keep Actual state, all saga files, the operation journal, reimbursement
links, reimbursement suggestions, and every other reference sidecar together. A server version
that does not understand repayment confirmation sagas must not serve mutation traffic while any
repayment confirmation record is nonterminal.

Before downgrade, inventory every nonterminal `repayment-confirmation-sagas.json` record and
reconcile or complete it on the current version. Nonterminal records must not be deleted or
relabeled merely to enable rollback. After downgrade, unresolved repayment confirmation work
blocks conflicting transaction and sidecar mutations for its owned ids until manually reconciled
or upgraded again.

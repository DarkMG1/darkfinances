# Splitwise mirror safety contract

`splitwise-mirror-resolutions.json` stores reviewed duplicate-tag resolutions.
`bulk-operation-sagas.json` records with `kind: "splitwise_mirror"` execute mirror
work through the PR-11 bulk executor (no parallel saga engine).

## Admission

- Schema-v2 `owes-truth.json` must pass `validateSplitwiseMirrorSnapshot` (complete
  manifest, fresh timestamp, unique item ids, exact cent shares via `toCents`).
  Preflight and new-run validation failures surface as `503 STALE_UPSTREAM_DATA`
  (journal terminal `failed`, same-key replay returns the same code/status).
- Missing resolutions file defaults to schema-v1 empty; wrong/future schema, malformed
  entries, duplicate `sourceId` records, keep/drop overlap, or incomplete observed sets
  fail closed before any saga/structural/Actual effects (invalid records are never
  silently discarded; unknown top-level fields are preserved).
- Mirror account/category admission rejects closed accounts, multiple name matches, and
  ambiguous fallback category identity (no first/last silent choice). Bootstrap effects
  re-fetch and re-run structural admission after the effect fault hook; post-effect
  enumeration must show exactly one open account/category matching the checkpointed id.
- Live mirror rows index as `Map<sourceId, row[]>` using the **last** `#sw-<id>` tag in
  notes (embedded decoy tags in descriptions must not win over the canonical trailing
  tag). When both `imported_id` and tags are present they must agree on source id;
  disagreement or duplicate imported ids fail closed with `409 SPLITWISE_MIRROR_AMBIGUOUS`
  and `sourceIds` containing numeric Splitwise expense ids (never raw imported_id strings).
- Before every mirror create/update/delete/duplicate-drop effect the saga re-indexes the
  full mirror account and fails closed on unplanned duplicate growth, imported-id drift,
  or reviewed-duplicate row/fingerprint drift (completed drops may be absent).
- Unreviewed duplicate live tags fail closed before any saga/structural/Actual effects
  with `409 SPLITWISE_MIRROR_AMBIGUOUS`.
- A resolution binds `sourceId`, the exact observed `{ id, fingerprint }` duplicate
  set, `keepTxnId`, exact `dropTxnIds`, and `reviewedAt`. Stale/malformed/mismatched
  resolutions fail closed like unreviewed ambiguity and delete nothing.

## Plan checkpoint

Before effects the saga persists canonical `snapshotBinding`
`{ fingerprint, generatedAt, manifest, mirrorAttempt? }`. The binding is revalidated
after all items, before sidecars/sync-pending, before sync, and before terminalization.
If the snapshot changes after destructive work, the saga becomes `unresolved` (not
`completed`) so a new operation can converge the new snapshot.

## Stages (deterministic)

1. `splitwise_bootstrap_account` / `splitwise_bootstrap_category` (bootstrap resource
   keys owned by every nonterminal mirror saga)
2. reviewed `splitwise_duplicate_drop` (deletion delegation)
3. `splitwise_delete` for removed/zero-share sources (deletion delegation)
4. `splitwise_create` with durable `darkfinances:splitwise-mirror:<sourceId>` imported_id
5. `splitwise_update` converging amount/sign, date, category, notes/description/payer tag

Creates enforce exactly one imported_id per source before/after add and at terminalization;
imported-id/tag disagreement, tag decoys, duplicate imported_ids, and foreign-account
checkpointed txn ids are `unresolved`. Apply-then-throw recovery locates exactly one row
by imported_id or legacy tag+intent and checkpoints the assigned txn id.

## Ownership and API

Mirror `sourceId` resources and bootstrap keys stay owned through `sync_pending` until
terminal `completed`/`unresolved`. Deletes delegate to PR-09 deletion sagas via PR-11;
delegated delete resume skips external deletion-in-progress conflicts. Unreviewed ambiguity
never schedules delete. Missing delete targets without proven delegation are `unresolved`.

### v1 journal and error semantics

- **Preflight snapshot/admission failure** (before any bulk saga): journal terminal
  `failed` with documented codes (`STALE_UPSTREAM_DATA`, `SPLITWISE_MIRROR_*`). Same-key
  replay returns the same failure; no stuck `started` and no bulk effects.
- **In-flight / mid-effect ambiguity or bootstrap TOCTOU after a saga exists**: bulk saga
  becomes `unresolved`; direct callers and keyed v1 retries surface
  `409 BULK_OPERATION_OUTCOME_UNKNOWN` until a new idempotency key or conditions change.
- Keyed `unresolved` mirror sagas are immutable evidence; callers must use a new
  idempotency key to retry after fixing upstream state.

### Null-key automation (no idempotency key)

Direct `syncSplitwiseShareExpenses` without an operation key:

1. Resume the sole active null-key saga first (even if current owes-truth is stale;
   binding verification may mark the saga `unresolved`).
2. With no active saga: replay a matching **completed** saga for the same
   `snapshotBinding.fingerprint`.
3. With no active/completed saga but prior **unresolved** attempts for the same binding:
   start a fresh deterministic next-attempt saga (`mirrorAttempt` increments; old
   unresolved records are never mutated).
4. After a later attempt completes, same-snapshot direct calls replay that completed
   attempt.

`POST /api/v1/splitwise/sync-shares` runs read-only mirror preflight through `dataModule`
before journal local application, then uses `finalizeBulkMutation` with journal fingerprint
and `splitwise_mirror` kind binding, terminal proof polling, and exact result replay.
Legacy fields `{ ok, account, items, created, updated, pruned }` are preserved.

## Deployment and downgrade

Do not serve mutation traffic from a pre-PR-12 server while any nonterminal
`splitwise_mirror` bulk record exists. Restore generation-bound backups with matching
Actual, deletion sagas, owes-truth, resolutions sidecar, and bulk-operation sagas.

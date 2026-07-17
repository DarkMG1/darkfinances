# Operation journal safety contract

The journal keeps its existing outer shape:

```json
{
  "schemaVersion": 1,
  "operations": {}
}
```

New entries use `recordVersion: 2` and `fingerprintVersion: 2`. The request body and raw query are never stored. Nonterminal records deliberately retain `status: "started"` so the previous server blocks re-execution after rollback.

| Durable phase | Legacy-compatible status | Meaning |
| --- | --- | --- |
| `started` | `started` | Admission is durable; no claim about effects is made. |
| `local_applied` | `started` | The domain call returned and `provisionalResult` is durable. |
| `sync_unknown` | `started` | Local application is durable and an external/Actual sync may or may not have completed. |
| `completed` | `completed` | The final result is durable and replayable. |
| `failed` | `failed` | A bounded failure is known to have happened before the first-effect boundary. |

Legal forward transitions are:

- `started -> local_applied -> sync_unknown -> completed`
- `started -> local_applied -> completed` for sidecar-only work
- `started -> failed` only for an explicitly typed deterministic pre-effect error

No-domain-write actions use an explicit no-op `local_applied` checkpoint before external synchronization. Repeating a transition with equivalent canonical JSON is idempotent. Conflicting data and every backward transition fail closed. A handler that returns without its required checkpoint is left unresolved rather than reported as successful.

## Fingerprint v2

The SHA-256 input consists of the uppercase method, canonical pathname, canonical query pairs, and canonical JSON body. Object keys are recursively sorted, array order is preserved, query names are sorted while repeated-value order and multiplicity are retained, and URL fragments are excluded. JSON strings are preserved exactly; Unicode normalization is not guessed.

Records without `fingerprintVersion` are compared with the old method/path/`JSON.stringify(body)` algorithm. This preserves replay of old completed records. Old `started` and `failed` records are both outcome-unknown: the old server could write effects before recording `failed`, so neither is automatically retryable.

## Failure and replay behavior

- A journal admission write failure prevents handler execution.
- Only `KnownPreApplyError` before an explicit first-effect boundary becomes terminal `failed`. This marker covers request validation and confirmed receipt account or transaction absence; plain errors, generic `AppError` values, and failures inferred from a status or message remain unknown.
- Once the effect boundary is crossed, any handler or checkpoint error returns `OUTCOME_UNKNOWN`; the durable nonterminal record blocks another execution.
- `local_applied` is written immediately after the domain call returns.
- `sync_unknown` is written before `syncNow`.
- A sync error, timeout, process exit, or completion-write error remains `sync_unknown`.
- Completed requests replay the durable result with `replayed: true`.
- Known pre-effect failures replay their bounded code, message, and HTTP status.
- When a mutation uses a durable bulk saga keyed by the same idempotency key, a nonterminal journal record may reconcile to `completed` from independently proven terminal bulk state without re-executing the handler. Reconciliation runs on same-key mutation replay and on `GET /api/v1/operations/:key` under the mutation queue. Fingerprint conflict checking still applies before replay. Terminal proof must match the journal record fingerprint/version (and bound method/route/kind) exactly; internal bulk calls without a journal fingerprint never prove. Missing, duplicate, corrupt, `sync_pending`, or `unresolved` bulk records never reconcile. Conflicting terminal journal results are never overwritten. Reconciliation write failures remain outcome-unknown and retryable; equivalent retries are idempotent. Versioned mutations serialize journal start, reconciliation, handler work, and completion on the mutation queue.
`GET /api/v1/operations/:key` is authenticated and returns only the stable status view. Legacy ambiguous failures are exposed as `status: "started"`, `phase: "started"`, `outcome: "unknown"`, never as terminal failures.

## Mutation coverage

`lib/mutation-route-registry.js` is the authoritative inventory of every versioned mutation, its lifecycle class, synchronization requirement, and first-effect boundary. Versioned writes can only be registered through `registerV1Mutation`; coverage tests reject a direct `v1.post`, `v1.put`, `v1.patch`, or `v1.delete` registration and reject registry/registration drift.

Functions that already hide replacement, deletion, repayment, receipt, or bulk writes remain conservatively non-atomic at the journal layer. This journal prevents duplicate execution and preserves uncertainty; repayment confirmation additionally uses `repayment-confirmation-sagas.json` for saga convergence (see `REPAYMENT_CONFIRMATION.md`).

## Pruning

Pruning retains at most 1,000 terminal records, ordered by terminal timestamp and then key. Every unresolved record is retained, including legacy ambiguous failures. Missing or invalid timestamps can only affect ordering among terminal records.

## Rollback and deployment

The previous server accepts the unchanged outer schema and sees every new nonterminal phase as `status: "started"`. Because it does not understand fingerprint v2, a retried new operation can return `IDEMPOTENCY_KEY_REUSED` instead of `OUTCOME_UNKNOWN`; either immediate response blocks execution. It may also be unable to replay new completed or failed records for the same reason.

Rollback has a hard pruning limitation: the previous server keeps 1,000 records total and does not distinguish terminal from unresolved records. If it is allowed to accept writes after rollback, its next prune can eventually delete an older unresolved record and make that key appear new. Therefore the previous server must not serve mutation traffic while any unresolved new or legacy operation exists.

Before deployment:

1. Drain mutation traffic, ensure exactly one journal-writing server process exists with no old/new overlap, and take a verified backup containing the operation journal and all registered sidecars.
2. Validate the journal with the new code and inventory every new or legacy unresolved operation.
3. Reconcile unresolved effects manually; never delete or relabel them merely to enable a retry.
4. Keep the new server and journal backup together through the observation window.

Before rollback, repeat the backup and unresolved-operation inventory. Roll back a mutation-serving instance only when that inventory is empty; otherwise keep the new server or disable mutations until every effect is reconciled. This deployment gate plus terminal-only pruning in the new server prevents an operation from becoming automatically retryable after possible effects. Do not resume an operation with a new key unless its local and remote effects have been independently reconciled.

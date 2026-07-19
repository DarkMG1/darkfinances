# Query scaling (PR-31)

Bounded ledger reads keep dashboard/API query cost proportional to requested windows instead of scanning full account history.

## Architecture

- `lib/query-scaling-config.js` — env-backed caps (`FINANCE_QUERY_MAX_LEDGER_DAYS`, row limits, search lookback, `FINANCE_QUERY_LEDGER_CHUNK_DAYS`).
- `lib/query-completeness.js` — shared `boundedLifetimeMetric` for incomplete lifetime totals with null authoritative values and optional lower bounds.
- `lib/bounded-ledger-access.js` — canonical date validation, calendar-chunked sequential `getTransactions` fetch (Actual has no cancellable limit API; `@actual-app/api` `runQuery`/AQL is not used for transaction windows), row-budget enforcement before retention, signed keyset search cursors bound to coordinator generation, instrumentation headers.
- `dataModule.js` — spending merged scan, incomplete reimbursement/repayment/trends net-worth semantics, merchant history cap wiring.
- `server.js` — legacy + v1 read instrumentation via closed-over stats (no ALS cross-leak); cache fingerprints include query caps/generation/cursors.
- `actual-tools/lib/bounded-ledger-access.js` — vendored standalone copy (regenerate with `node finance-dashboard/scripts/sync-bounded-ledger-vendor.js`).

Lifetime semantics remain explicit: `ledgerScan.complete`, `totalOwed.complete`, `scope.netWorthHistoryComplete`, and lower-bound labels — never silent truncation or fabricated zero.

## Abort limitation

`getTransactions` has no cancellation hook in `@actual-app/api`. Abort signals stop subsequent account/chunk calls after the in-flight request completes; `X-Finance-Query-Aborted` marks early termination.

During process shutdown (`SIGTERM`/`SIGINT`), `lib/process-shutdown-abort.js` aborts accepted ledger reads at the next bounded fetch boundary before HTTP admission closes. See `lib/graceful-shutdown.js` step 0 and [`ACTUAL_COORDINATOR.md`](../ACTUAL_COORDINATOR.md).

Integration tests use atomic filesystem markers under `FINANCE_QUERY_TEST_BARRIER_DIR` (test-only) so shutdown abort is observed without racing HTTP polling during admission drain.

Every PR runs the deterministic in-flight read shutdown gate via `npm run check`. Full bounded
stress is opt-in or scheduled; see [`../../ops/README.md`](../../ops/README.md#graceful-shutdown-verification).

## Reproduction

```bash
cd finance-dashboard
npm test -- --test-name-pattern 'bounded ledger|query scaling'
node scripts/benchmark-query-scaling.js
cd .. && npm run check
```

## Env knobs

| Variable | Default | Purpose |
| --- | --- | --- |
| `FINANCE_QUERY_MAX_LEDGER_DAYS` | 3660 | Max inclusive date span for ledger scans |
| `FINANCE_QUERY_MAX_LEDGER_ROWS` | 100000 | Max rows retained per read |
| `FINANCE_QUERY_LEDGER_CHUNK_DAYS` | 120 | Calendar chunk size for sequential fetches |
| `FINANCE_QUERY_MAX_TXN_LIST_ROWS` | 10000 | Max formatted transaction rows returned |
| `FINANCE_QUERY_MAX_SEARCH_RANGE_DAYS` | 1095 | Max search window |
| `FINANCE_QUERY_CURSOR_SECRET` | ACTUAL_SYNC_ID | HMAC secret for search cursors; required on non-local deployments when `ACTUAL_SYNC_ID` is absent or invalid |
| `FINANCE_QUERY_BUDGET_MS` | 120000 | Instrumentation budget marker |

Production and other non-local deployments fail closed at startup when neither `FINANCE_QUERY_CURSOR_SECRET` nor a validated `ACTUAL_SYNC_ID` (≥8 chars, not the dev fallback) is configured. The dev-only fallback applies only under `NODE_ENV=test`, `DEMO_ONLY=1`, or loopback development.

Row-cap semantics: `rowsScanned` may exceed `FINANCE_QUERY_MAX_LEDGER_ROWS` when a single Actual chunk allocates more rows than the retain budget, but `peakRowsRetained` (and `X-Finance-Query-Peak-Retained`) never exceeds the cap.

Exceeded bounds return HTTP 400 (`QUERY_RANGE_EXCEEDED`) or 413 (`QUERY_RESULT_LIMIT_EXCEEDED`).

# Query scaling (PR-31)

Bounded ledger reads keep dashboard/API query cost proportional to requested windows instead of scanning full account history.

## Architecture

- `lib/query-scaling-config.js` — env-backed caps (`FINANCE_QUERY_MAX_LEDGER_DAYS`, row limits, search lookback).
- `lib/bounded-ledger-access.js` — canonical date validation, sequential per-account `getTransactions` fetch, shared metadata context, cache fingerprints, search cursors, and response instrumentation headers.
- `dataModule.js` — spending, trends, review, insights, merchant history, recurring/income, reimbursement, search/tags, and phantom cleanup now route through bounded helpers.
- `server.js` — cache keys fingerprint every window/filter/pagination input; responses include `X-Finance-Query-*` counters without payload/principal leakage.

Lifetime semantics (trends net worth, reimbursement ledger cutoff) remain explicit via `scope.netWorthHistoryComplete`, `ledgerCutoff`, `ledgerScan.complete`, and validated env cutoffs rather than silent truncation.

## Reproduction

```bash
cd finance-dashboard
npm test -- --test-name-pattern 'bounded ledger|query scaling'
node scripts/benchmark-query-scaling.js
npm --prefix .. test
```

## Env knobs

| Variable | Default | Purpose |
| --- | --- | --- |
| `FINANCE_QUERY_MAX_LEDGER_DAYS` | 3660 | Max inclusive date span for ledger scans |
| `FINANCE_QUERY_MAX_LEDGER_ROWS` | 100000 | Max rows scanned per read |
| `FINANCE_QUERY_MAX_TXN_LIST_ROWS` | 10000 | Max formatted transaction rows returned |
| `FINANCE_QUERY_MAX_SEARCH_RANGE_DAYS` | 1095 | Max search window |
| `FINANCE_QUERY_BUDGET_MS` | 120000 | Instrumentation budget marker |

Exceeded bounds return HTTP 400 (`QUERY_RANGE_EXCEEDED`) or 413 (`QUERY_RESULT_LIMIT_EXCEEDED`).

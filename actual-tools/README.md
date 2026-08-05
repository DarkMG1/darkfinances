# Actual Tools

`actual-tools` contains deterministic command-line reports and maintenance utilities for Actual Budget,
Splitwise, Venmo, and DarkFinances sidecars.

Most tools are read-only. The few that can mutate Actual are dry-run by default and require
`CONFIRM=1`. Snapshot/import tools write only explicitly configured local JSON outputs and use atomic
replacement.

## Requirements

- Node.js 24 recommended.
- Python 3 for the safe scratch-directory check in `run.sh`.
- `@actual-app/api` resolvable by Node (installed by the monorepo root `npm install`).
- A disposable Actual cache under `/tmp` or `~/.cache/actual-tools`.
- Splitwise credentials only for tools that call Splitwise.

Keep the Actual server and `@actual-app/api` on compatible versions. A version mismatch can surface as
database schema errors during download or sync.

## Setup

From the repository root:

```bash
npm install
cp actual-tools/.actual.env.example actual-tools/.actual.env
cp actual-tools/.splitwise.env.example actual-tools/.splitwise.env
cp actual-tools/splitwise-groups.example.json actual-tools/splitwise-groups.json
cp actual-tools/collection-rules.example.json actual-tools/collection-rules.json
cp actual-tools/build-rules-config.example.json actual-tools/build-rules-config.json
```

Only create `.splitwise.env` if Splitwise is enabled. Populated environment/config files are
gitignored because they contain secrets and personal identity mappings.

### Actual environment

`.actual.env` exports:

| Variable | Purpose |
| --- | --- |
| `ACTUAL_SERVER_URL` | Actual server URL. |
| `ACTUAL_PASSWORD` | Budget/server password. |
| `ACTUAL_SYNC_ID` | Target budget Sync ID. |
| `FIX_DATA_DIR` | Disposable downloaded-budget cache. |
| `OWES_TRUTH_PATH` | Output consumed by Finance Dashboard. |
| `EVENTS_PATH` | Optional dashboard event sidecar override. |
| `VENMO_TRUTH_PATH` | Optional Venmo snapshot output override. |

`FIX_DATA_DIR` is removed before every `run.sh` execution. Create it first with mode `0700`; it must
be an owned directory strictly below `/tmp` or `~/.cache/actual-tools`. The allowed roots themselves,
missing paths, symlinks, `/`, the home directory, and unrelated paths are rejected.

### Splitwise environment

Use either:

- `SPLITWISE_API_KEY`, or
- `SPLITWISE_CONSUMER_KEY` plus `SPLITWISE_CONSUMER_SECRET`.

`SPLITWISE_CURRENCY` defaults to `USD`. Mixed-currency groups fail instead of being silently summed.

### Group and identity mapping

`splitwise-groups.json` maps DarkFinances event slugs to Splitwise group IDs or unambiguous group names.
Numeric IDs are preferred. Event slugs correspond to transaction tags such as `#ev-trip-2026`.

The `surname` entries map aliases to canonical person slugs. Keep aliases explicit and unique; identity
collisions abort snapshot/import generation.

Events created in Finance App can also provide a Splitwise group and are merged into the snapshot map.
Mapping the same Splitwise group to multiple events is rejected.

## Safe runner

Use `run.sh` for Actual-backed tools:

```bash
bash run.sh finance-digest.js
bash run.sh month-review.js
bash run.sh owes-snapshot.js
```

The runner:

1. Validates the requested script is a direct child of this directory (no traversal, symlinks, or options).
2. Reads and validates `FIX_DATA_DIR` from `.actual.env` without loading secret-bearing variables.
3. Sources `.actual.env` and optional `.splitwise.env` only after those checks succeed.
4. Recreates the already-owned cache with private permissions.
5. Re-validates the script immediately before execution, then runs Node with `pipefail`, preserving tool failures through output filtering.

Python 3 is required for canonical path checks in `run.sh` (script allowlisting and disposable cache roots).

Run commands from this directory unless an example includes an absolute path.

## Tool catalog

### Deterministic read-only reports

| Tool | Output |
| --- | --- |
| `finance-digest.js` | Daily exact figures for prior-day spend, month-to-date spend, balances, uncategorized activity, and anomalies. |
| `finance-weekly.js` | Weekly recap with deterministic period boundaries and integer-cent arithmetic. |
| `month-review.js` | Month-to-date categorized transaction audit; money movement, reimbursement, and income are summarized separately. |
| `reimb-report.js` | Dashboard-compatible lifetime reimbursement ledger and debt summary. |

All finance date boundaries use `FINANCE_TIME_ZONE`, then `TZ`, then `America/Los_Angeles`.
Shared date-only helpers live in `lib/date-only.js` (strict `YYYY-MM-DD` values, UTC-agnostic
calendar math, and `todayYMD()` anchored to the finance zone rather than process UTC).
Cross-runtime parity with `finance-dashboard/lib/date-only.js` and
`finance-app/src/lib/finance-date-core.js` is enforced by `test/finance-date-parity.test.js`.

Example:

```bash
FINANCE_TIME_ZONE=America/Los_Angeles bash run.sh finance-digest.js
```

These scripts calculate values themselves; downstream automation should format their output, not
recompute the numbers.

### Splitwise diagnostics

```bash
bash splitwise-run.sh --group "Trip name" --print
bash splitwise-run.sh --reconcile "Trip name"

source .splitwise.env
node sw-pairwise.js "Trip name"
```

- `splitwise-pull.js` writes normalized private JSON pulls and can also print group expense information.
- `splitwise-reconcile.js` compares itemized-derived values with authoritative pairwise balances.
- `sw-pairwise.js` provides direct pairwise diagnostics.
- Splitwise API requests use timeouts, bounded retries, and backoff.
- Group-name resolution fails on no match or ambiguity; it does not guess.
- HTTP failures surface as `SplitwiseRequestError` with endpoint, status, and allowlisted
  machine codes only. Response bodies, names, IDs, and tokens are never included in thrown or
  logged errors by default. Optional debug body capture requires
  `SPLITWISE_DEBUG_RESPONSE_BODY=1` and remains non-enumerable on the error object.
- Error-body parsing reads at most `SPLITWISE_ERROR_BODY_BYTES` (clamped to 64–4096; default 512).
  Retryable 5xx/429 bodies are cancelled before backoff; terminal failures still become structured
  safe errors.

These diagnostics are read-only against Splitwise.

### Authoritative Who Owes Me snapshot

```bash
bash run.sh owes-snapshot.js
```

`owes-snapshot.js`:

- Uses `get_friends -> friend.groups[].balance` as the only per-person Splitwise debt authority.
- Uses `simplified_debts` only in repayment-routing tools, never debt totals.
- Keeps itemized expenses only for spend mirroring and reconciliation diagnostics.
- Validates every configured event, unique group ownership, complete itemized data, and currency.
- Writes schema-v2 output with a complete manifest and mode `0600`.
- Creates a `.last-good` copy and atomically renames the new snapshot.
- Leaves the existing snapshot untouched if any group fails.

The dashboard rejects stale/incomplete manifests for destructive mirror pruning. If generation fails,
fix the source mapping/API issue; do not hand-edit a partial snapshot into place.

### Venmo statement import

Download a CSV from Venmo's statement page, then preview:

```bash
node venmo-import.js statement.csv --me "Your Full Name" --event "Trip name" --dry
```

Write after reviewing:

```bash
node venmo-import.js statement.csv --me "Your Full Name" --event "Trip name"
```

The importer reads pending charges where you are the requester, validates required columns, supports
quoted multiline CSV fields, and merges only the selected event into `venmo-truth.json`. Use `--flip`
only after confirming that your export reverses Venmo's normal From/To convention. `--out` overrides
the destination.

Statements contain sensitive personal and transaction data. Store them outside the repository and
delete temporary exports according to your own retention policy.

### Trip and event sidecar

`trip-quickadd.js` lists, adds, updates, or removes records in the same `events.json` sidecar used by the
dashboard and app:

```bash
node trip-quickadd.js list
node trip-quickadd.js add "Trip 2026" --start 2026-06-01 --members alex,sam --group "Trip Group"
node trip-quickadd.js rm trip-2026
```

Set `EVENTS_PATH` to override the default `../finance-dashboard/events.json`. A linked Splitwise group
is included on the next `owes-snapshot.js` run.

This helper edits the sidecar directly and therefore bypasses the dashboard mutation queue. It fails
closed on malformed input and writes atomically with mode `0600`, but should still not run concurrently
with event edits in the app/dashboard.

### Rule generation

`build-rules.js` proposes payee-to-category rules from historical consensus. It skips transfers,
income, money movement, peer-payment patterns, configured names, and ambiguous histories.

Preview:

```bash
bash run.sh build-rules.js
```

Apply only after reviewing every proposal:

```bash
CONFIRM=1 bash run.sh build-rules.js
```

The tool requires at least two categorized observations and at least 80% agreement. Customize exclusions
in private `build-rules-config.json`. Confirmed rule creation is synced before success is reported; API,
sync, or shutdown failures exit nonzero.

Operator regex configuration (`build-rules-config.json` skip patterns and
`collection-rules.json` debtor patterns) is validated before any Actual or Splitwise calls:

- Pattern count, per-pattern length, aggregate length, syntax, allowed flags (`i` only), and
  catastrophic-backtracking safety (`safe-regex2`).
- Zero-width or universal matchers that match empty input (for example `.*`, `|`, `(?:)`) are rejected.
- `skipNames` entries are bounded by count, per-entry length, and aggregate length.

Invalid operator regex configuration fails fast with stable `OPERATOR_REGEX_CONFIG_INVALID` errors and
does not silently skip patterns.

### Event repayment collection

`event-collect.js` finds incoming repayments that match a private event rule and tags/categories them in
Actual. It uses Splitwise simplified debts only to predict who should route payment, then applies amount
and identity safeguards.

Preview:

```bash
COLLECTION_EVENT=trip-2026 bash run.sh event-collect.js
```

Apply:

```bash
COLLECTION_EVENT=trip-2026 CONFIRM=1 bash run.sh event-collect.js
```

Transactions outside configured amount ratios are reported for manual review, not changed.
In confirmed mode, each tagged transaction is synced as a resume checkpoint. If a later item fails, the
command exits nonzero; rerunning safely skips the already-tagged checkpoints and resumes the remaining
transactions.

## Safety model

- Read-only reports never call Actual mutation APIs.
- Actual-mutating tools require `CONFIRM=1`.
- Scratch caches are disposable and path-guarded.
- Splitwise reads use strict group and currency validation.
- Snapshots are all-or-nothing and atomic.
- Venmo imports are event-scoped and atomic.
- Personal configs and generated financial state remain gitignored.
- Tool failures return nonzero status so systemd/cron can alert reliably.

Before applying a write tool, run its dry mode, verify the target Sync ID, and ensure a current Actual
backup exists.

## Scheduling

Use absolute paths and an explicit timezone in schedulers. For example:

```cron
CRON_TZ=America/Los_Angeles
15 6 * * * cd /srv/darkfinances/actual-tools && /usr/bin/bash run.sh owes-snapshot.js >> /var/log/darkfinances/owes-snapshot.log 2>&1
```

Prefer the checked-in systemd services/timers where available because they provide private umasks,
timeouts, failure alerts, and journal status. See [`../ops/README.md`](../ops/README.md).

## Tests

From the repository root:

```bash
npm run check:tools
```

This syntax-checks every JavaScript tool and runs tests for retry handling, group resolution,
multi-currency rejection, snapshots, CSV parsing/merging, and runner safety.

## Finance Dashboard account projection parity

The dashboard server (`finance-dashboard`) owns authoritative account projection for net worth,
operating/liquid cash, spending attribution, and Splitwise mirror identity. `actual-tools` CLI
reports read Actual directly and **do not** consume dashboard account overrides, role assignments,
or the durable Splitwise mirror ID contract (`SPLITWISE_MIRROR_ACCOUNT_ID`, `owes-config.json`
`mirrorAccountId`, bulk-saga `mirrorRuntime.accountId`).

Until a deployment contract ships override/mirror metadata to tools, treat CLI balances and
name-based Splitwise heuristics as **non-authoritative** relative to dashboard metrics. Do not
invent account-name resolution in tools; configure durable mirror IDs in dashboard sidecars instead.

## License

MIT. See [`LICENSE`](./LICENSE).

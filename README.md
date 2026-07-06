# DarkFinances

DarkFinances is a self-hosted personal-finance system built around
[Actual Budget](https://actualbudget.org/). The dashboard API reads and writes
Actual, the mobile app is a thin client over that API, and the tools package
produces the Splitwise/Venmo snapshot data used by Who Owes Me.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `finance-dashboard/` | Express API and web dashboard over Actual Budget. Owns business logic, JSON endpoints, write handlers, runtime sidecar files, and static web UI. |
| `finance-app/` | Expo / React Native app using `expo-router` and React Query. Stores server URL/token locally on device and talks to `/api/v1`. |
| `actual-tools/` | Read-only Actual/Splitwise/Venmo helper scripts. Produces Who Owes Me snapshots and import sidecars consumed by the dashboard. |

Runtime secrets, personal roster files, generated snapshots, receipts, and
financial state are intentionally gitignored. Commit only templates, source,
and non-personal documentation.

## Architecture

```text
Banks/SimpleFIN -> Actual Budget -> finance-dashboard API -> finance-app
                         ^                 ^
                         |                 |
                   actual-tools -> owes-truth.json / venmo-truth.json
```

The source of truth for transactions and categories is Actual Budget. The
dashboard computes spending, budgets, trends, reimbursements, recurring bills,
goals, reconciliation state, and receipts. The mobile app renders those API
responses and sends edits back through dashboard write endpoints.

## Who Owes Me

Who Owes Me uses a hybrid model:

- Direct personal fronts live in Actual as `Reimbursement` category expenses
  and repayments. By default, direct ledger debts scan all history.
- Personal deployments may set `REIMB_LEDGER_FROM=YYYY-MM-DD` to ignore direct
  ledger reimbursement rows before a known settled cutoff date.
- Splitwise-governed trip/group debts come from `actual-tools/owes-snapshot.js`.
- For Splitwise groups, per-person debt must come only from Splitwise pairwise
  balances: `get_friends -> friend.groups[].balance`.
- Itemized Splitwise expense data may be retained for spend mirroring and audit
  metadata, but it must not feed `bySlug` or `byEvent` debt totals.

If `owes-truth.json` is missing, the dashboard can fall back to legacy baseline
configuration, but the app surfaces the source and generation time so this is
visible.

Optional reimbursement env vars:

- `REIMB_LEDGER_FROM` — exclude direct Actual-ledger reimbursement rows before
  this date from current Who Owes Me.
- `REIMB_SUGGEST_FROM` — start repayment suggestions from this date. Defaults to
  January 1 of the current year.

## Setup

Install workspace dependencies from the repo root:

```bash
npm install
```

Then create local runtime files from the templates you need:

```bash
cp finance-dashboard/.env.example finance-dashboard/.env
cp finance-dashboard/personal-config.example.json finance-dashboard/personal-config.json
cp finance-dashboard/owes-config.example.json finance-dashboard/owes-config.json
cp actual-tools/.actual.env.example actual-tools/.actual.env
cp actual-tools/.splitwise.env.example actual-tools/.splitwise.env
cp actual-tools/splitwise-groups.example.json actual-tools/splitwise-groups.json
```

Fill those local files with your own Actual/Splitwise settings. Do not commit
the filled-in copies.

## Common Commands

```bash
npm run check
npm run check:dashboard
npm run check:app
npm run check:tools
```

Package-specific commands:

```bash
npm --prefix finance-dashboard start
npm --prefix finance-app start
bash actual-tools/run.sh owes-snapshot.js
```

## Dashboard API

The dashboard exposes versioned JSON under `/api/v1`. Mobile clients authenticate
with `X-Finance-Token` or `Authorization: Bearer <token>`. Browser access can use
the passkey-protected web dashboard.

Important endpoint families:

- Transactions: list, detail, category/date/payee/notes edits, split/unsplit.
- Spending: spending, trends, insights, budgets, income, recurring, bills.
- Reimbursements: Who Owes Me, reimbursement ledger, repayment suggestions,
  reimbursement links.
- System state: goals, manual assets, rules, receipts, reconciliation, events.

Dashboard runtime JSON files live next to the deployed server and are gitignored.
Examples include `personal-config.json`, `owes-config.json`, `owes-truth.json`,
`events.json`, `reimb-links.json`, `rules.json`, `goals.json`, and receipts.

## Mobile App

The app is an Expo managed project. The backend URL and token are configured at
runtime and stored on device. Most JS/asset changes ship with EAS Update as long
as the app runtime version still matches the installed native build.

Do not bump `finance-app/app.json` `version` for an OTA-only change. The current
runtime policy is `appVersion`, so a version bump requires a new native build.

## Deployment

Operational hostnames, secrets, and exact service details should live outside
this repo. General flow:

1. Run `npm run check` from the monorepo root.
2. Deploy changed dashboard files to the server's dashboard directory.
3. If dashboard dependencies changed, run `npm install` in the deployed
   dashboard directory.
4. Restart the dashboard service and verify `/api/v1/ping`.
5. Deploy changed `actual-tools` scripts to the server's tools directory.
6. Regenerate `owes-truth.json` with `bash run.sh owes-snapshot.js`.
7. Publish app JS changes with EAS Update when native config did not change.

## GitHub

This monorepo replaces the older standalone repositories for the dashboard,
mobile app, and tools. Keep future work in this repository so API, app, and
snapshot changes can be reviewed and deployed together.

## License

MIT. See package-level `LICENSE` files.

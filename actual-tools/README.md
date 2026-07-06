# DarkFinances — Actual Tools

Command-line helpers that feed the [DarkFinances dashboard](../finance-dashboard). They talk to
[Actual Budget](https://actualbudget.org/) and [Splitwise](https://www.splitwise.com/) **read-only**
and produce the snapshot files the dashboard's Who-Owes-Me reads.

> These scripts never write to Splitwise and only ever *read* your Actual budget. The single side
> effect is writing snapshot JSON files.

## Tools

| Script | What it does |
| --- | --- |
| `owes-snapshot.js` | Builds the authoritative Who-Owes-Me snapshot (`owes-truth.json`) from Splitwise's pairwise friend/group balances. Itemized Splitwise data is kept only as spend metadata and diagnostics. Also pulls in any trip you created in the app that links a Splitwise group. |
| `venmo-import.js` | Turns a Venmo statement CSV into `venmo-truth.json` (pending charges you're owed), merged into Who-Owes-Me. |
| `trip-quickadd.js` | Create/list/remove trips (`events.json`) from the CLI. |
| `splitwise-pull.js` | Print/inspect a Splitwise group's balances. |
| `splitwise-reconcile.js` | Cross-check Splitwise vs. the ledger. |
| `sw-pairwise.js` | Pairwise balance audit helper; this is the same source used for Who-Owes-Me debts. |

## Setup

```bash
npm install @actual-app/api        # if not already available
cp .actual.env.example .actual.env         # Actual server creds + output paths
cp .splitwise.env.example .splitwise.env   # Splitwise API creds (optional)
cp splitwise-groups.example.json splitwise-groups.json   # your #ev-<slug> -> group map
```

## Usage

```bash
# Rebuild the Who-Owes-Me snapshot
bash run.sh owes-snapshot.js

# Inspect a Splitwise group
bash splitwise-run.sh --group "my group" --print

# Import a Venmo statement (pending charges become debts)
node venmo-import.js ~/Downloads/venmo_statement.csv --me "Your Full Name" --event "June Splits"

# Manage trips
node trip-quickadd.js add "Trip 2026" --members alex,sam --group "trip group"
node trip-quickadd.js list
```

## Configuration

Secrets are sourced from `.actual.env` / `.splitwise.env` (gitignored — see the `*.example` files).
Your personal `#ev-<slug> → Splitwise group` map and surname aliases live in the gitignored
`splitwise-groups.json` (template: `splitwise-groups.example.json`).

## License

MIT — see [LICENSE](./LICENSE).

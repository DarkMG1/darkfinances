# DarkFinances — Mobile App

A fast, private personal-finance app for iOS (React Native + [Expo](https://expo.dev)). It's the
client for the self-hosted [DarkFinances dashboard](../finance-dashboard), which sits on top of
[Actual Budget](https://actualbudget.org/).

> Your data stays between your phone and your own server. The app talks only to the dashboard URL
> you configure — there is no third-party backend.

## Features

- Spending, trends, budgets, cash flow, and net worth at a glance
- Transactions with search, categorization, splits, tags, and on-device receipt OCR
- **Who-Owes-Me** — a lifetime reimbursement ledger (Splitwise + Venmo aware)
- **Trips & Events** — group charges and track who owes you per trip
- Recurring bills & subscriptions, income tracking, goals
- Auto-categorization rules + a built-in merchant catalog
- Optional month-end reconciliation, Face ID lock

## Requirements

- Node.js 18+ and the [Expo CLI](https://docs.expo.dev/)
- Xcode (for iOS builds/simulator)
- A running [DarkFinances dashboard](../finance-dashboard) reachable from your device

## Get started

```bash
npm install
npx expo start
```

Open in the iOS Simulator, or use a development build on device. On first launch, enter your
**dashboard URL** and **API token** (the `FINANCE_API_TOKEN` you set on the dashboard). These are
stored securely on device — nothing is hardcoded in the app.

## Project layout

- `src/app` — screens (file-based routing via `expo-router`)
- `src/api` — typed API client, hooks, and endpoint catalog
- `src/components`, `src/theme`, `src/lib` — UI, styling, and utilities

## Configuration & privacy

- No secrets are committed. The server URL and API token are entered at runtime and kept in secure
  storage on the device.
- `.env*.local` and generated native folders are gitignored.

## Related

- [`finance-dashboard`](../finance-dashboard) — the JSON API this app talks to.
- [`actual-tools`](../actual-tools) — Splitwise/Venmo importers for Who-Owes-Me.

## License

MIT — see [LICENSE](./LICENSE).

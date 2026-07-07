# Maestro UI Tests

Maestro drives the installed iOS or Android app like a user would: launch, tap, assert visible UI, scroll, and capture screenshots.

## Install

```sh
curl -Ls "https://get.maestro.mobile.dev" | bash
```

Restart your shell after installing so the `maestro` command is on `PATH`.

## iOS Simulator Setup

Start the dashboard backend in another terminal. Maestro uses the app's demo mode against this local host, so no real API token is needed.

```sh
DEMO_ONLY=1 npm --prefix ../finance-dashboard start
```

Install a local iOS build before running flows:

```sh
npm run ios
```

The app id used by the flows is `dev.darkmg1.finances`, from `app.json`.

On a fresh simulator, the flows tap **Use demo data** on onboarding. This stores `http://127.0.0.1:5007` with demo mode enabled.

## Run

From `finance-app`:

```sh
npm run test:e2e:ios
npm run test:e2e:ios:spending
npm run test:e2e:ios:drilldown
npm run test:e2e:ios:transaction
```

From the monorepo root:

```sh
npm run test:e2e:ios
```

Screenshots created by `takeScreenshot` are written by Maestro into its run output. Use these artifacts to compare the real simulator UI against the reference screenshots in `Downloads/rm-screenshots`.

## Flows

- `.maestro/spending-smoke.yaml` checks the Spending overview and lower sections.
- `.maestro/spending-drilldown.yaml` opens the Total Spend drilldown and checks transaction-list chrome.
- `.maestro/transaction-detail.yaml` opens a transaction and checks the detail action menu.

## Notes

- These flows intentionally use `testID` selectors for navigation and major anchors, then visible text assertions for user-facing content.
- If a flow cannot find data-dependent rows, refresh the app against the live backend or use demo data with representative transactions.


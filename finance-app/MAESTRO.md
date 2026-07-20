# Maestro UI Tests

Maestro drives an installed Finance App build like a user: launching, tapping, entering text, opening
deep links, scrolling, asserting visible UI, and capturing screenshots.

The flows use Finance Dashboard's synthetic demo mode. They do not require a real API token and must not
be pointed at live financial data.

## Install Maestro

```bash
curl -Ls "https://get.maestro.mobile.dev" | bash
```

Restart the shell if `maestro` is not yet on `PATH`, then verify:

```bash
maestro --version
```

For the optional privacy-animation frame analyzer, also install Pillow:

```bash
python3 -m pip install Pillow
```

## Prepare the iOS simulator

1. Start or boot an iOS Simulator.
2. Start Finance Dashboard in demo-only mode from `finance-app`:

   ```bash
   DEMO_ONLY=1 npm --prefix ../finance-dashboard start
   ```

3. Build and install the app in another terminal:

   ```bash
   npm run ios
   ```

4. Confirm that `http://127.0.0.1:5007/api/v1/ping?demo=1` is reachable from the simulator host.

The app ID is `dev.darkmg1.finances`. Fresh-state flows tap **Use demo data**, which stores the local
demo URL and enables demo mode. Most flows use `launchApp.clearState: true`, so they can run
independently and cannot inherit a live server token.

## Run tests

From `finance-app`:

```bash
# Every flow (privacy matcher runs for the full suite lifetime)
npm run test:e2e:ios

# Onboarding, Home, Activity, and Settings
npm run test:e2e:ios:core

# Planning, recurring items, bills, subscriptions, and goals
npm run test:e2e:ios:planning

# Review, reconciliation, reimbursement, rules, events, and transaction creation
npm run test:e2e:ios:workflows

# Spending and drilldowns
npm run test:e2e:ios:spending

# Merchant/tag drilldowns only
npm run test:e2e:ios:drilldown

# Transaction details and actions
npm run test:e2e:ios:transaction

# Face ID/privacy gate
npm run test:e2e:ios:privacy
```

From the monorepo root, `npm run test:e2e:ios` runs the complete app suite.

Run one flow directly while iterating:

```bash
bash scripts/run-maestro-ios.sh .maestro/home-dashboard.yaml
```

iOS Maestro scripts route through `scripts/run-maestro-ios.sh`, which resolves `MAESTRO_APP_ID`, enrolls
simulator biometrics, and—when the target includes `privacy-unlock.yaml` or the full `.maestro` directory—
posts biometric match notifications for exactly the Maestro process lifetime. Override the booted simulator
with `DEVICE=booted` (default) or a specific UDID.

## Suite map

| Flow | Coverage |
| --- | --- |
| `onboarding-tabs.yaml` | Validation, demo onboarding, and top-level navigation. |
| `home-dashboard.yaml` | Home hero, balances, and key dashboard sections. |
| `activity-workflows.yaml` | Activity list, search/filter, and transaction routing. |
| `settings-workflows.yaml` | Connection, privacy, notification, and diagnostic controls. |
| `planning-analytics.yaml` | Planning and analytics screens. |
| `recurring-bills-subscriptions.yaml` | Recurring, bill, and subscription details. |
| `goals-workflows.yaml` | Goal list and edit/create behavior. |
| `review-reconcile-reimbursement.yaml` | Review inbox, reconciliation, and reimbursement screens. |
| `rules-events.yaml` | Categorization rules and event/trip management. |
| `add-transaction.yaml` | Manual transaction creation. |
| `spending-smoke.yaml` | Spending overview and lower-page sections. |
| `spending-drilldown.yaml` | Total-spend transaction drilldown. |
| `bills-utilities-drilldown.yaml` | Bills/Utilities category drilldown. |
| `merchant-tag-drilldowns.yaml` | Merchant and tag totals/lists. |
| `transaction-detail.yaml` | Canonical transaction detail and actions menu. |
| `transaction-actions.yaml` | Date/category/tag/split workflows. |
| `privacy-unlock.yaml` | Background privacy lock and biometric unlock. |

## Privacy-animation evidence

The regular privacy flow verifies state transitions. To sample simulator frames during the transition
and detect consecutive visual changes:

```bash
npm run test:e2e:ios:privacy:animation
```

Outputs are written under `build/privacy-animation/`. Override the booted simulator, app ID, output
directory, or flow with `DEVICE`, `APP_ID`, `OUT_DIR`, and `FLOW`. The animation script reuses
`scripts/run-maestro-ios.sh` for biometric matching instead of a fixed-duration loop.

The analyzer reports frame counts, meaningful pixel deltas, longest changing-frame run, and peak delta.
It is a regression aid, not a substitute for human review of captured frames.

## Selector conventions

- Use `testID` selectors for navigation, controls, and major screen anchors.
- Use visible text for user-facing assertions.
- Prefer deep links for deterministic navigation to nested screens.
- Keep demo fixture IDs explicit when a test needs a known transaction.
- Avoid screen coordinates except when dismissing a native sheet without a stable semantic control.
- Give asynchronous data/navigation an explicit bounded `extendedWaitUntil`.

Do not add real server URLs, tokens, names, account labels, receipts, or transaction details to flows or
screenshots.

## Screenshots and artifacts

Maestro stores `takeScreenshot` artifacts in its run output. Keep only sanitized screenshots needed for
regression review. The privacy-animation script writes sampled frames to its configured output
directory, which is under the ignored `build/` tree by default.

## Troubleshooting

- **App not found:** run `npm run ios` and confirm the bundle ID is `dev.darkmg1.finances`.
- **Onboarding cannot reach demo:** verify the demo-only dashboard is listening on `127.0.0.1:5007`.
- **Unexpected live-server state:** uninstall/reset the app, then rerun a flow with `clearState: true`.
- **Deep-link Open prompt appears:** flows handle the simulator's optional **Open** confirmation.
- **Face ID flow times out:** run through `npm run test:e2e:ios:privacy` so the in-repo biometric matcher wrapper is active; do not rely on manual background `simctl` loops.
- **Element not found:** run the single flow, inspect the Maestro hierarchy/artifacts, and prefer adding a
  stable `testID` over timing sleeps.
- **Data-dependent row missing:** update the synthetic demo fixture and its tests; do not switch E2E to a
  live account.
- **Animation analyzer fails:** ensure Pillow is installed and the selected simulator is booted.

## Adding or changing a flow

1. Keep it deterministic and demo-only.
2. Start with a clean app state unless the flow is intentionally chained.
3. Add semantic `testID`s in the app where needed.
4. Add the YAML file under `.maestro/`.
5. Include it in the appropriate `package.json` suite script.
6. Run the individual flow and the containing suite.
7. Run `npm test` and `npm run lint` for app-level regressions.

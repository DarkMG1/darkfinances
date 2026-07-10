# Finance App

Finance App is the Expo/React Native client for DarkFinances. It presents the authenticated
`finance-dashboard` API as a native iOS/Android experience with offline-friendly cached reads, biometric
privacy controls, local notifications, receipt capture, and an optional iOS widget.

The app does not connect directly to Actual Budget. All financial reads and writes go through the
dashboard's versioned `/api/v1` contract.

## Highlights

- Home, spending, transactions, planning, budgets, reports, goals, and net-worth views.
- Transaction creation, categorization, split editing, payee/notes/date updates, and deletion.
- Review, reconciliation, reimbursement, recurrence, rules, events, and manual-asset workflows.
- Face ID gate plus a native iOS privacy shield when the app backgrounds.
- Server-scoped React Query caches and cancellable requests.
- Foreground/network refresh and visible server health.
- Receipt camera/library upload with on-device resize, JPEG conversion, and OCR-assisted review.
- Local reminders for bills, budgets, large charges, low balances, and uncategorized activity.
- Optional iOS Home Screen widget for net worth and the next bill.
- Redacted diagnostic export for troubleshooting.
- Synthetic demo mode that cannot access or mutate live finance data.

## Requirements

- Node.js 24 recommended.
- A running `finance-dashboard`.
- Xcode and CocoaPods for native iOS builds.
- Android Studio for native Android builds.
- Maestro only for end-to-end UI tests.

Because the app uses custom native modules, widgets, and config plugins, use a native development build.
Expo Go is not a complete test environment for this project.

## Install

From the repository root:

```bash
npm install
```

Or from this directory:

```bash
npm install
```

Start Metro:

```bash
npm start
```

Build and launch a native target:

```bash
npm run ios
npm run android
```

`npm run ios` regenerates/compiles the local native development target as needed. To explicitly
regenerate the iOS project:

```bash
npm run prebuild
```

Prebuild uses `--clean` and replaces `ios/`; keep native customization in Expo config plugins rather
than editing generated files manually.

## Connect to a server

On onboarding or Settings, provide:

1. The public HTTPS origin of `finance-dashboard`.
2. The value configured as `FINANCE_API_TOKEN` on that server.

The app verifies `/api/v1/ping` before saving a changed connection. Production builds reject insecure
HTTP URLs; development builds allow loopback addresses such as `http://127.0.0.1:5007`.

The API token is stored with SecureStore and displayed masked in Settings. Server identity includes the
normalized URL, token, and demo state. When it changes, the app:

- Aborts in-flight requests.
- Clears in-memory React Query data.
- Switches to notification baselines namespaced for the new server.
- Rebuilds or clears the widget snapshot from the new state.
- Refetches from the newly selected server.

This prevents data from one server or demo session appearing in another.

## Demo mode

Tap **Use demo data** during onboarding. Demo mode uses the dashboard's isolated synthetic fixtures,
requires no API token, and performs no persistent writes.

For local UI development, start a demo-only backend:

```bash
DEMO_ONLY=1 npm --prefix ../finance-dashboard start
```

The default development demo URL is `http://127.0.0.1:5007`. A build can override it with
`EXPO_PUBLIC_FINANCE_DEMO_URL`.

## Privacy and local data

- Face ID can lock the UI after a configurable grace period.
- The iOS privacy shield covers app content immediately when the app leaves the foreground.
- Financial query caches are scoped to the configured server and cleared on disconnect.
- Receipt images are resized and converted on device, then uploaded immediately; they are not retained
  as an app-managed local receipt archive.
- Widget data is minimized and cleared on disconnect or demo mode.
- Diagnostic export includes build/runtime information, server host, and query health, but excludes the
  API token, full URLs, query parameters, transaction values, payees, notes, and category labels.

The server still holds sensitive finance and receipt data. Secure and back up that host appropriately.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/app/` | File-based screens and routes. |
| `src/api/` | Typed request client, generated contracts, and React Query hooks. |
| `src/components/` | Shared UI plus notification and widget synchronization. |
| `src/lib/` | Dates, diagnostics, notifications, receipts, requests, storage, and utilities. |
| `src/state/` | Runtime server/token/demo configuration. |
| `src/widgets/` | iOS widget definitions and snapshot model. |
| `plugins/` | Native privacy and free-sideload Expo config plugins. |
| `scripts/` | Native build, OTA, sideload, and visual-regression helpers. |
| `test/` | Node-based unit/config-plugin tests. |
| `.maestro/` | End-to-end simulator flows. |

## Notifications

Notifications are local and optional. Enable individual categories from Settings. Baselines are
namespaced by server identity so changing servers or entering demo mode cannot produce alerts from stale
data.

The scheduler handles:

- Upcoming and same-day unpaid bills.
- Budget thresholds.
- Large newly observed charges.
- Low account balances.
- New uncategorized transactions.

Notification permissions and native entitlements depend on the build path. The free-sideload build
removes the push-notification entitlement, but local notification scheduling remains available.

## iOS widget

The full native configuration includes small and medium widgets through `expo-widgets` and an App Group.
The widget displays the same visible-account/manual-asset net-worth definition used by Home plus the
next unpaid bill.

Widgets require an Apple provisioning profile that supports App Groups. They are intentionally omitted
from free Apple ID/Sideloadly builds.

## iOS delivery

### Simulator

```bash
npm run ios
```

Simulator builds do not require signing.

### Signed device or EAS build

The normal config includes widgets, App Groups, notifications, the native privacy shield, and EAS
Update. Build profiles live in `eas.json`:

```bash
npx eas-cli@latest build --platform ios --profile preview
npx eas-cli@latest build --platform ios --profile production
```

A paid Apple Developer team and compatible provisioning are required for the full entitlement set.

### Unsigned IPA for Sideloadly

When the Mac cannot sign locally, build a widget-free unsigned IPA:

```bash
npm run sideload:ios
```

The script sets `FREE_IOS_SIDELOAD=1`, performs a clean prebuild, removes unsupported App Group/push
entitlements, disables the widget target, compiles without code signing, and packages:

```text
build/sideload/DarkFinances-<version>-<build>-unsigned.ipa
```

Sideloadly signs that IPA at installation time with the selected Apple ID. This path requires Xcode,
Python 3, CocoaPods, and installed npm dependencies. Free provisioning commonly requires reinstalling
the app every seven days.

Do not manually clear signing settings in generated Xcode files; the unsigned build script supplies the
required `xcodebuild` flags reproducibly.

## OTA updates

EAS Update can publish JavaScript and asset changes to an installed compatible native binary:

```bash
npm run ota:publish
bash scripts/ota-publish.sh preview "describe the update"
```

The default branch/environment is `production`. OTA updates cannot add or change native modules,
plugins, entitlements, Info.plist values, widgets, or the native privacy shield. Those changes require a
new IPA/native build.

`runtimeVersion` follows the app version. Changing `expo.version` creates a new native runtime; rebuild
and reinstall before expecting updates for that version.

## Quality checks

```bash
npm test
npm run lint
```

`npm test` runs TypeScript checking and Node-based unit/plugin tests. Linting is separate.

Run Maestro UI tests against an installed simulator build:

```bash
npm run test:e2e:ios
npm run test:e2e:ios:core
npm run test:e2e:ios:privacy
```

See [`MAESTRO.md`](./MAESTRO.md) for setup, suite groups, and troubleshooting.

## Troubleshooting

- **Server test fails:** confirm the URL is the dashboard origin, not the Actual URL; then check
  `/api/v1/ping`, TLS, and the API token.
- **Ping returns `503`:** the dashboard is running but Actual startup/sync is not ready.
- **HTTP URL rejected:** use HTTPS, or a loopback URL in a development build.
- **Old data appears after a change:** use Settings → Disconnect and reconnect; this clears scoped
  caches and baselines.
- **Widget missing:** verify that the build used full entitlements, not `FREE_IOS_SIDELOAD=1`.
- **OTA not received:** confirm the installed app version/runtime and EAS channel match the update.
- **Native linker or module error:** run a clean prebuild and CocoaPods install through the documented
  build command.

## License

MIT. See [`LICENSE`](./LICENSE).

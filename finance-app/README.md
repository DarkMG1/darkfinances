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

## Mutation idempotency and recovery

One logical mobile mutation is the combination of the live server/profile identity, uppercase HTTP
method, canonical endpoint pathname, canonically key-sorted query pairs, and canonical JSON variables.
Object keys are sorted recursively; array order and duplicate-query-value order are preserved. A
SHA-256 digest of that identity is the local lookup key. The URL, token, endpoint, query, and variables
exist only while computing the digest and are never written to idempotency storage.

Before a live mutation can use the network, the app writes a `prepared` MMKV record and then writes
`dispatching`. The record contains only schema version, 64-character request and profile digests, the
idempotency key, lifecycle state, and timestamps. The same MMKV snapshot carries a non-sensitive
monotonic generation number that makes later terminal invocations distinct. Keys are domain-separated
SHA-256 values derived
from the request/profile digests, timestamp, and durable generation number; the profile digest includes
the server's documented long-random API token. Hashing uses the audited JavaScript-only
`@noble/hashes` package and adds no native module.

The same key is reused while the record is:

- `prepared`: no dispatch was recorded, so a user invocation may send it once with the existing key.
- `dispatching` or `outcome_unknown`: the app performs authenticated
  `GET /api/v1/operations/:key` status reads and never automatically replays the mutation.

`completed` returns the server's durable result and removes the local record. `failed` reconstructs the
server's stored status/code/message, throws it, and removes the record. Only after one of those terminal
outcomes—or after discarding a `prepared` record that was provably never dispatched—may a later
intentional mutation receive a new key. Timeout, abort, transport failure, malformed response,
`started`, `local_applied`, `sync_unknown`, and explicit `OUTCOME_UNKNOWN` all retain the key.
`OPERATION_NOT_FOUND` after dispatch is also outcome-unknown: the request may predate server journal
retention or admission may have failed, so a missing record is never permission to resend.

Pending metadata is rehydrated from MMKV after restart. Startup and foreground recovery issue status
GETs only; they do not replay POST, PUT, PATCH, or DELETE requests, start background mutation workers,
or persist React Query's mutation cache. If foreground recovery finds a completed operation, all active
finance queries for that same profile are marked stale and refetched without haptics. Other profiles
remain untouched. A refetch failure leaves those queries stale and records only a stable error code,
numeric status, and timestamp; it does not restore the completed operation or send a mutation. A later
successful foreground reconciliation or profile purge clears that diagnostic; a failed reconciliation
or blocked purge retains it. Demo mutations bypass idempotency persistence entirely.

Changing or deleting a live profile is blocked while that profile has a `dispatching` or
`outcome_unknown` record. This intentionally keeps the old URL/token available for authenticated
reconciliation instead of silently deleting a safety record and allowing a duplicate under a new
profile. A profile change may discard `prepared` records because they were durably recorded before any
network dispatch. This safety-over-convenience tradeoff can temporarily prevent disconnecting when the
server cannot be reached; replacement/abandonment recovery is deliberately outside this mechanism.

## Mutation outcome haptics (L5)

Generic write confirmation haptics are owned exclusively by `useFinanceMutation` in
`src/api/client/requests.ts`. **Logical haptic identity is the idempotency operation key**
(the durable `Idempotency-Key` header value). The request digest derived from profile,
method, endpoint, and body is **callback lookup only** — it resolves the operation key in
mutation `onSuccess` / `onError` handlers. Each operation key emits at most one success
**or** one error haptic:

- Terminal success → one `success` haptic, then the session closes.
- Terminal failure (4xx with a stable code) → one `warning` haptic, then the session closes.
- Non-terminal transport/outcome-unknown states (`OUTCOME_UNKNOWN`, timeout while the operation journal
  retains the key) → **no** haptic until a terminal outcome is known; the session stays open.
- A later distinct user action with the same payload receives a **new** idempotency key and may
  haptic again after the prior operation reached a terminal outcome.
- Idempotency status polling, in-flight replay/coalescing, foreground reconciliation, and cache
  refetches after recovered completions → **no** haptics.
- Pass `suppressOutcomeHaptic: true` on a mutation hook for non-user/background writes.

The in-memory session map is capped (128 by default). Expired and least-recent abandoned unknown
sessions are evicted before new tracking is installed. When every slot holds a genuinely active
retry, excess operations are not tracked and emit no outcome haptic rather than evicting an active
operation.

Screens may keep `haptics.tap()` for navigation and selection. Documented semantic exceptions that do
**not** duplicate mutation outcome ownership:

- Destructive-action confirmation (`haptics.warning()` before a delete dialog).
- Non-mutation failures such as CSV export (`buildQuery` GET).

Screens must **not** call `haptics.success()` or `haptics.warning()` inside mutation `onSuccess` /
`onError` callbacks. Client-side validation rejected before a request may use
`hapticClientValidationRejected()` when the UX already promises tactile feedback. Capability/platform
haptic errors are swallowed and never change mutation results.

Inventory and behavioral tests live in `test/haptic-call-site-inventory.js` and
`test/mutation-outcome-haptics.test.js`.

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
- Pending mutation storage contains digests and lifecycle metadata only, never request bodies, financial
  values, receipt images, credentials, or server URLs.
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
build/sideload/DarkFinances-<version>-<build>-release-manifest.json
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
bash scripts/ota-publish.sh preview "describe the preview update"
bash scripts/ota-publish.sh free-sideload "describe the sideload update"
```

The default target uses the full runtime with the `production` branch/channel/environment. `preview`
uses the same full runtime with the checked-in `preview` branch/channel/environment.
`free-sideload` uses its isolated runtime and branch/channel with the production EAS environment.
Production and preview mappings must match `eas.json`; arbitrary channel or environment substitution
is rejected. OTA updates cannot add or change native modules, plugins, entitlements, Info.plist
values, widgets, or the native privacy shield. Those changes require a new IPA/native build.

Immediately before publication, the script captures the source digest. It publishes directly to the
requested stable branch, captures EAS machine-readable update evidence, and writes
`dist/ota-release-manifest.json` only if the returned branch/runtime and configured channel still
match and the source digest is unchanged. Publication precedes provenance generation; a provenance
failure does not roll back EAS, but it produces no valid final manifest and preserves the private
temporary EAS JSON for diagnosis. `OTA_CHANNEL`, when set, must equal the configured branch channel.
Set `OTA_MANIFEST_PATH` to choose a different destination.

The full build follows the app version. The free-sideload build uses
`<app-version>-free-sideload` on the separate `free-sideload` channel. Changing either runtime requires
a rebuild and reinstall before expecting updates for that binary.

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

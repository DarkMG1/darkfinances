# Building & Sideloading the Finances app

The app is a normal Expo (React Native) project. There is **no App Store / TestFlight**
involved — you build an unsigned `.ipa` on your Mac and install it on your iPhone
with a sideloading tool that re-signs it using your own Apple ID.

- Bundle id: whatever you configure in `app.json` (default in this repo: `dev.darkmg1.finances`)
- Display name: **Finances**
- Server it talks to: the Express dashboard API you enter during onboarding, via `/api/v1`

---

## 1. Prerequisites (one time)

- macOS with **Xcode** + Command Line Tools (`xcode-select --install`)
- **CocoaPods**: `brew install cocoapods`
- Node deps: from this folder run `npm install`
- An Apple ID (a free one works; see expiry note below)

---

## 2. Run on a connected device (dev)

Fastest way to see it on your phone while iterating:

```bash
npm run ios:device      # Release build onto a plugged-in iPhone (Xcode signs with your Apple ID)
# or
npm run ios             # debug build + Metro
```

Xcode will ask you to pick a signing team the first time — choose your personal
("Personal Team") account.

---

## 3. Build an unsigned IPA for sideloading

```bash
npm run release:ios
```

This runs `scripts/ios-build.sh`, which:

1. `expo prebuild --clean` (regenerates `ios/`),
2. `pod install`,
3. archives the `Finances` scheme **without code signing**,
4. zips `Payload/Finances.app` into `dist/Finances.ipa`.

The output is `dist/Finances.ipa`. It is intentionally **unsigned** — the sideload
tool signs it with your Apple ID at install time.

---

## 4. Install it on your iPhone

Pick one:

### AltStore (recommended — supports background refresh)
1. Install **AltServer** on your Mac, and **AltStore** on the iPhone (via AltServer).
2. In AltStore on the phone: **My Apps → +** → pick `dist/Finances.ipa`.
3. AltServer re-signs and installs it. Keep AltServer running on a machine on the
   same network so it can auto-refresh the 7-day signature.

### Sideloadly (simple one-off)
1. Install **Sideloadly** on the Mac, plug in the iPhone.
2. Drag `dist/Finances.ipa` in, enter your Apple ID, click **Start**.

> **Signing expiry:** a *free* Apple ID signature lasts **7 days** (and max 3
> sideloaded apps); re-run the refresh (AltStore does this automatically) or
> reinstall. A *paid* Apple Developer account lasts **1 year**.

After install, trust the developer profile once:
**Settings → General → VPN & Device Management → (your Apple ID) → Trust**.

---

## 5. First launch

1. Open **Finances**. The onboarding screen asks for:
   - **Server URL**: your dashboard origin, for example `https://finances.example.com`
   - **API token**: the value of `FINANCE_API_TOKEN` set on the server's
     environment.
2. Tap **Connect** (it calls `/api/v1/ping` to verify), then optionally enable
   **Face ID lock** in Settings.

The token is stored in the iOS Keychain (`expo-secure-store`); the server URL in
MMKV. Neither leaves the device.

---

## 6. Over-the-air (OTA) JS updates

OTA lets you push JS/asset changes to an already-installed build **without**
rebuilding/reinstalling the IPA — as long as the native `runtimeVersion`
(`app.json → runtimeVersion.policy = "appVersion"`) hasn't changed. Native/dep
changes or a version bump still require a fresh IPA (steps 3–4).

### One-time setup (free Expo account)
```bash
npx eas-cli@latest login
npm run ota:configure     # eas update:configure — writes updates.url + extra.eas.projectId into app.json
```
Then build + sideload **one** IPA (step 3–4) so the native side learns the update URL.

### Publishing an update
```bash
npm run ota:publish                       # branch "production"
# or: bash scripts/ota-publish.sh preview "message"
```

### Getting the update on the phone
- Automatic: the app checks on launch (`updates.checkAutomatically: "ON_LOAD"`).
- Manual: **Settings → About → Check for Updates** (downloads then offers to restart).

---

## Troubleshooting

- **`pod install` fails**: `cd ios && pod repo update && pod install`.
- **Archive fails on signing**: the script already passes `CODE_SIGNING_ALLOWED=NO`;
  make sure you're invoking it via `npm run release:ios` and not a stale Xcode scheme.
- **App opens then closes immediately after 7 days**: the free-Apple-ID signature
  expired — refresh in AltStore or reinstall.
- **"Check for Updates" says it only runs in a release build**: OTA is disabled in
  Metro/dev; it only works in the sideloaded Release IPA after `ota:configure`.

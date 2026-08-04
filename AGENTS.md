# AGENTS.md

## Cursor Cloud specific instructions

This repo (`darkfinances`) is an npm-workspaces monorepo: `finance-dashboard` (Express API +
passkey web dashboard), `finance-app` (Expo/React Native client), `actual-tools` (CLI), and `ops`.
See `README.md` and the per-package READMEs for the authoritative commands; only Cloud-specific,
non-obvious caveats are captured here.

### Toolchain / environment
- Node is pinned to `24.18.0` (`.nvmrc`) and npm to `10.9.2` (`packageManager`). The base image's
  `/exec-daemon/node` is Node 22 and sits ahead of nvm on `PATH`. During setup, `node`/`npm`/`npx`
  symlinks were added in `/usr/local/cargo/bin` (which precedes `/exec-daemon` in the base `PATH`)
  pointing at the nvm Node 24 install, so every shell type (login, non-interactive, `sh -c`) resolves
  Node 24. `~/.bashrc` also prepends the nvm bin as a redundant fallback. Verify with `node -v`
  (expect `v24.18.0`); if it ever shows v22, run
  `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`.
- The update script runs `node scripts/ensure-declared-npm.js` (bootstraps pinned npm 10.9.2 from a
  verified tarball) then `npm ci`. `npm run check:toolchain` rejects npm drift.
- Runtime config lives in gitignored `*.example` copies (e.g. `finance-dashboard/.env`). Recreate them
  as shown in the README "Quick start" when a live/local config is needed; they are not required for
  the demo-mode or test workflows.

### Running the services (dev)
- Dashboard demo (no Actual server needed): from `finance-dashboard`,
  `DEMO_ONLY=1 PORT=5007 npm start` serves the API + web dashboard on `http://127.0.0.1:5007`.
  Synthetic data only; writes return simulated success.
- The public versioned API `/api/v1/*` serves demo data with header `X-Demo-Mode: 1` and needs NO
  auth (used by the native app). Every `/api/v1` write requires a unique `Idempotency-Key` header.
- The browser dashboard at `/demo` calls the LEGACY `/api/*` endpoints, which are passkey-session
  gated (not demo-aware). To view the full browser UI locally without enrolling a passkey, start the
  demo server with `SELFTEST=1` as well (`DEMO_ONLY=1 SELFTEST=1 PORT=5007 npm start`). `SELFTEST` is
  code-guarded to loopback `PUBLIC_ORIGIN` only and is intended for local/loopback testing.
- Mobile app: `npm --prefix finance-app start` (Metro) or `npx expo start --web --port 8081` for a
  browser build. The app's native runtime is iOS/Android (Xcode required); Expo web bundles and
  renders the UI but native modules (secure-store, local-auth, mmkv, widgets) are limited on web.
  The app's "Use demo data" button targets `http://127.0.0.1:5007` in dev. Note: the Expo **web**
  build cannot reach the dashboard cross-origin — `/api/v1` rejects a mismatched `Origin` (CORS), so
  end-to-end app→dashboard data flow on web is blocked; use a real iOS/Android client for that.

### Lint / test / build
- Full suite: `npm run check` (offline). Network/host-dependent gates are separate and NOT part of
  the core loop: `check:vulnerabilities` (runs `npm audit`, needs network) and `check:compose`
  (needs Docker, not installed by default).
- `npm run check:ops` includes a `systemd-analyze verify` test that FAILS in this container because
  systemd is not PID 1 (`Failed to initialize manager: No such device or address`); this is an
  environment limitation, not a code defect.
- `finance-dashboard/test/demo-forecast-sts-containment.test.js` is date/time-of-day sensitive: it
  depends on the live clock and can fail on some dates/instants (obligation-graph completeness). It
  passes when time is pinned, e.g. `DEMO_FINANCE_NOW=2026-08-04`. Unrelated to environment setup.
- There is no compile/build step for the dashboard/tools (CommonJS Node). App "build" targets are
  native (`expo prebuild`, `expo run:ios/android`) and require Xcode/Android tooling.

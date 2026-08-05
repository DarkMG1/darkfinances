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
  Synthetic data only; writes return simulated success. Under `DEMO_ONLY=1`, unmarked API requests
  are forced into demo isolation (or rejected) — do not rely on a live token against a demo-only
  process.
- The public versioned API `/api/v1/*` serves demo data with header `X-Demo-Mode: 1` and needs NO
  auth (used by the native app). Every `/api/v1` write requires a unique `Idempotency-Key` header.
- The browser dashboard at `/demo` appends `?demo=1` to legacy `/api/*` fetches; demo-claimed legacy
  GETs/writes are exempt from the passkey session gate. Prefer `/api/v1` for new browser work.
  `SELFTEST=1` remains code-guarded to loopback `PUBLIC_ORIGIN` only and is for local/loopback tests —
  not a product workaround.
- Mobile app: `npm --prefix finance-app start` (Metro) or `npx expo start --web --port 8081` for a
  browser build. The app's native runtime is iOS/Android (Xcode required); Expo web bundles and
  renders the UI but native modules (secure-store, local-auth, mmkv, widgets) are limited on web.
  The app's "Use demo data" button targets `http://127.0.0.1:5007` in dev. Note: the Expo **web**
  build cannot reach the dashboard cross-origin — `/api/v1` rejects a mismatched `Origin` (CORS), so
  end-to-end app→dashboard data flow on web is blocked; use a real iOS/Android client for that.

### Ops / restore
- Ops is an interpreted CLI/tooling surface; it has no separate build or long-running development
  service. Use root `README.md` / package scripts for Node/npm setup and standard checks.
- Exercise backup/restore behavior only with the synthetic fixtures under `ops/test/`. Never run
  restore commands against personal or production runtime data.
- `restore-dashboard-runtime.sh` is preview-only. Live restore must run through
  `restore-coordinated.sh`, which holds the coordinated operation gate while writers are stopped and
  the staged swap runs.

### Lint / test / build
- Full suite: `npm run check` (offline). Network/host-dependent gates are separate and NOT part of
  the core loop: `check:vulnerabilities` (runs `npm audit`, needs network) and `check:compose`
  (needs Docker, not installed by default).
- `npm run check:ops` is the focused ops gate. A `systemd-analyze` failure caused solely by the
  container lacking a running systemd instance is environmental; do not ignore other shell, unit, or
  restore-test failures.
- Prefer pinning demo/finance “today” in tests with `DEMO_FINANCE_NOW` when exercising forecast/STS
  or obligation-graph fixtures.
- There is no compile/build step for the dashboard/tools (CommonJS Node). App "build" targets are
  native (`expo prebuild`, `expo run:ios/android`) and require Xcode/Android tooling.

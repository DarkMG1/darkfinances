# DarkFinances

DarkFinances is a self-hosted personal-finance system built around
[Actual Budget](https://actualbudget.org/). It combines an authenticated API and web dashboard, an
Expo/React Native mobile client, and deterministic Splitwise/Venmo tooling.

Actual remains the source of truth for accounts, transactions, categories, and balances. DarkFinances
adds mobile workflows, reports, reimbursements, receipts, recurrence detection, local notifications,
widgets, operational automation, and recovery tooling without sending financial data to a hosted
DarkFinances service.

## Repository layout

| Path | Purpose |
| --- | --- |
| [`finance-dashboard/`](./finance-dashboard) | Express API and passkey-protected web dashboard. Owns finance calculations, Actual reads/writes, API validation, runtime sidecars, and demo fixtures. |
| [`finance-app/`](./finance-app) | Expo/React Native client for iOS, Android, and web. Uses `expo-router`, React Query, Face ID, local notifications, receipts, and an optional widget. |
| [`actual-tools/`](./actual-tools) | Deterministic Actual/Splitwise/Venmo reports, imports, snapshot generation, and CONFIRM-gated maintenance tools. Root workspace package with pinned `@actual-app/api`. |
| [`ops/`](./ops) | Reproducible Docker Compose, systemd, backup/restore, alerting, and log-rotation assets. |
| [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) | Repository-wide verification on pushes and pull requests. |

Runtime secrets, personal rosters, generated snapshots, receipts, signing credentials, and financial
state are gitignored. Commit templates and source, never populated personal configuration.

## Architecture

```text
Banks / SimpleFIN
       |
       v
Actual Budget <------ @actual-app/api ------ finance-dashboard
   source of truth                              |
                                                | /api/v1
Splitwise / Venmo                               v
       |                                  finance-app
       v
actual-tools ------ owes-truth.json
             \----- venmo-truth.json
```

The dashboard is the only application-facing writer to Actual. Mutations are serialized, validated,
synced before success is returned, and exposed through versioned endpoints under `/api/v1`.

## Major capabilities

- Spending, income, budgets, cash flow, net worth, forecasts, reports, and merchant history.
- Split-aware transaction editing with replacement-ID migration and rollback protection.
- Lifetime reimbursement ledger with direct fronts, repayments, trips, Splitwise, and Venmo.
- Recurring bills/subscriptions, goals, reconciliation, categorization rules, and review inbox.
- On-device receipt OCR with bounded image processing and private server storage.
- Passkey browser login and token-authenticated native clients.
- Demo mode that is synthetic, rate-limited, non-persistent, and isolated from live data.
- Deterministic CLI reports suitable for scheduled delivery without model-side arithmetic.
- Private sidecar backups, restore safeguards, health checks, sync alerts, and log rotation.

## Who Owes Me data model

DarkFinances deliberately separates direct ledger debts from Splitwise-governed group debts:

- Direct fronts and repayments live in Actual under the `Reimbursement` category.
- `REIMB_LEDGER_FROM=YYYY-MM-DD` may exclude a known-settled historical period.
- Splitwise per-person debt comes **only** from `get_friends -> friend.groups[].balance`.
- Splitwise `simplified_debts` is only useful for predicting payment routing.
- Itemized expenses support spend mirroring and diagnostics; they never determine per-person debt.
- `actual-tools/owes-snapshot.js` produces an atomic, all-or-nothing schema-v2 manifest.
- The dashboard refuses to prune mirrored Splitwise spending from incomplete or stale snapshots.

See [`actual-tools/README.md`](./actual-tools/README.md) for setup and operational details.

## Requirements

- Node.js 24+ and the npm version declared in `packageManager` (`npm run check:toolchain`; CI runs `node scripts/ensure-declared-npm.js` before installs).
- npm with workspace support (`finance-dashboard`, `finance-app`, `actual-tools`).
- A self-hosted Actual Budget server aligned with the dashboard's `@actual-app/api` version.
- Optional Splitwise API credentials and Venmo statement exports.
- Xcode for iOS simulator/native compilation.
- Docker, systemd, and logrotate only if using the provided Linux operations assets.

## Quick start

Install workspace dependencies. When your global npm differs from the repo's declared
`packageManager` version (for example npm 11 on Node 26), bootstrap the pinned npm before
installing or running verification locally:

```bash
node scripts/ensure-declared-npm.js
npm install
```

`npm run check:toolchain` rejects npm drift from `packageManager`; CI runs the same bootstrap
step before every `npm ci`. This is a local development convenience, not part of production
deployment.

If npm already matches, `ensure-declared-npm` is a no-op:

```bash
npm install
```

Create private runtime configuration:

```bash
cp finance-dashboard/.env.example finance-dashboard/.env
cp finance-dashboard/personal-config.example.json finance-dashboard/personal-config.json
cp finance-dashboard/owes-config.example.json finance-dashboard/owes-config.json

cp actual-tools/.actual.env.example actual-tools/.actual.env
cp actual-tools/.splitwise.env.example actual-tools/.splitwise.env
cp actual-tools/splitwise-groups.example.json actual-tools/splitwise-groups.json
cp actual-tools/collection-rules.example.json actual-tools/collection-rules.json
cp actual-tools/build-rules-config.example.json actual-tools/build-rules-config.json
```

Fill only the integrations you use. The populated files are gitignored.

The dashboard does not implicitly load `.env`. Source it before local startup:

```bash
set -a
source finance-dashboard/.env
set +a
npm --prefix finance-dashboard start
```

Then start the app:

```bash
npm --prefix finance-app start
```

On first launch, enter the dashboard's HTTPS URL and `FINANCE_API_TOKEN`.

For a narrower setup, run the dashboard without Splitwise/Venmo and use the app against Actual only.
The package READMEs describe optional integrations separately.

## Verification

Run the complete repository suite (after matching the declared npm when needed):

```bash
node scripts/ensure-declared-npm.js
npm run check
```

Focused gates:

```bash
npm run check:alignment
npm run check:contract
npm run check:fixtures
npm run check:release
```

Or run one area:

```bash
npm run check:dashboard
npm run check:app
npm run check:tools
npm run check:ops
npm run test:e2e:ios
```

The suite covers backend unit/integration tests, request security, split rollback and reference
migration, date/report invariants, app typechecking/linting, config-plugin tests, tool failure handling,
snapshot completeness, and operations-script safety. The iOS E2E suite additionally requires Maestro,
a booted simulator, and an installed app build.

## Deployment options

### Dashboard and Actual

Production normally runs the dashboard and Actual on the same private host. Keep the Actual server,
dashboard dependency, and globally installed scheduled-sync client on the same release. The checked-in
Compose file pins the expected server version.

See [`ops/README.md`](./ops/README.md) for the deployment sequence, systemd units, backups, restore
guardrails, alerts, and log rotation.

### Mobile app

There are three supported delivery paths:

1. **OTA update** for JavaScript/assets when the installed native runtime is compatible.
2. **Signed native build** for dependency, entitlement, widget, notification, or privacy-shield changes.
3. **Unsigned IPA for Sideloadly** when local Apple signing is unavailable.

The free-sideload build intentionally removes widgets, App Groups, and notification support.
It uses the separate `free-sideload` OTA channel and `<app-version>-free-sideload` runtime so a
full-entitlement bundle cannot reach it. Use a full release build for local alerts. See
[`finance-app/README.md`](./finance-app/README.md).

## Security and privacy

- Native API access requires `X-Finance-Token`; browser access uses an enrolled WebAuthn passkey.
- Passkey enrollment is disabled unless a short-lived enrollment code hash is explicitly configured.
- State-changing browser requests reject a mismatched `Origin` and use `SameSite=Lax` session cookies.
- Production browser origins must be HTTPS.
- Application security headers include CSP, frame denial, no-sniff, no-referrer, and a restrictive
  permissions policy; the HTTPS reverse proxy should add HSTS.
- Authentication, passkey enrollment, demo access, and expensive endpoints are rate-limited.
  Reverse-proxy production deployments should set `FINANCE_TRUST_PROXY_HOPS=1` so limits honor the
  forwarded client address; absent values default fail-safe to `0`, ignore spoofed
  `X-Forwarded-For`, and emit a startup warning on non-loopback hosts.
- Sidecar JSON writes are atomic, schema-validated where applicable, and recover through last-good copies.
- Receipt paths and MIME content are validated before storage.
- App diagnostics redact tokens, URLs, query contents, transaction details, and personal labels.
- The app clears scoped query data and in-flight requests, namespaces notification baselines, and
  rebuilds widget state when its server identity changes.
- Cold offline persistence is intentionally unsupported. Data already loaded in memory is labeled
  offline, and financial mutations are never queued for later replay.

Do not expose the dashboard or Actual directly to the public internet without TLS and an additional
trusted access layer. Do not commit generated runtime files.

## Further documentation

- [`finance-dashboard/README.md`](./finance-dashboard/README.md) — API, auth, configuration, sidecars,
  demo mode, health checks, and tests.
- [`docs/RELEASE.md`](./docs/RELEASE.md) — release manifests, sideload vs full builds, contract/lockfile gates.
- [`finance-app/README.md`](./finance-app/README.md) — app setup, server onboarding, iOS builds, OTA,
  widgets, notifications, diagnostics, and E2E tests.
- [`actual-tools/README.md`](./actual-tools/README.md) — environment, tool catalog, safety model,
  snapshots, imports, and scheduling.
- [`ops/README.md`](./ops/README.md) — production deployment and recovery procedures.

## License

MIT. See the package-level `LICENSE` files.

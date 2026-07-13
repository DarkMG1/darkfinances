# Finance Dashboard

Finance Dashboard is the private server component of DarkFinances. It provides:

- A passkey-protected browser dashboard.
- A versioned JSON API for the mobile app.
- Finance calculations and reports derived from Actual Budget.
- Serialized, validated transaction and sidecar mutations.
- Isolated synthetic demo data for development and UI testing.

The process binds to `127.0.0.1` only. Put a trusted HTTPS reverse proxy in front of it for remote
access; do not bind it directly to a public interface.

## Data ownership

Actual Budget is authoritative for accounts, transactions, categories, schedules, and balances.
Dashboard-specific state lives in private JSON sidecars next to this package unless a path override is
configured.

Important guarantees:

- All write requests are validated with Zod.
- Backend mutations run through one serial queue.
- Actual writes sync before the API reports success.
- Split/edit/unsplit rebuilds migrate dependent receipt, reimbursement, and reconciliation references.
- A failed rebuild attempts rollback instead of leaving half-applied state.
- JSON sidecars use atomic replacement, last-good copies, and corruption quarantine.
- Finance date-only calculations use `FINANCE_TIME_ZONE` (default: `America/Los_Angeles`).

## Requirements

- Node.js 24 recommended.
- A reachable Actual Budget server.
- An Actual version compatible with the installed `@actual-app/api`.
- HTTPS for non-loopback browser/passkey deployments.

## Install

From the repository root:

```bash
npm install
cp finance-dashboard/.env.example finance-dashboard/.env
cp finance-dashboard/personal-config.example.json finance-dashboard/personal-config.json
cp finance-dashboard/owes-config.example.json finance-dashboard/owes-config.json
```

Optional feature configuration:

```bash
cp finance-dashboard/budget-settings.example.json finance-dashboard/budget-settings.json
cp finance-dashboard/investment-holdings.example.json finance-dashboard/investment-holdings.json
cp finance-dashboard/debt-planner.example.json finance-dashboard/debt-planner.json
```

Populated configuration and runtime state are gitignored.

## Configuration

The server reads process environment variables; it does not automatically load `.env`.

Required for a live server:

| Variable | Purpose |
| --- | --- |
| `ACTUAL_SERVER_URL` | URL of the self-hosted Actual server. |
| `ACTUAL_PASSWORD` | Password used to open the budget file. |
| `ACTUAL_SYNC_ID` | Budget Sync ID from Actual Settings → Advanced. |
| `ACTUAL_DATA_DIR` | Private local cache directory for the downloaded budget. |
| `FINANCE_API_TOKEN` | Long random secret sent by native clients as `X-Finance-Token`. |
| `SESSION_SECRET` | Stable random session-signing secret; mandatory outside loopback development. |
| `PUBLIC_ORIGIN` | Canonical browser origin, such as `https://finances.example.com`. |

Recommended:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5007` | Loopback listener port. |
| `SESSION_DIR` | `finance-dashboard/.sessions` | Persistent file-backed browser sessions. |
| `FINANCE_TIME_ZONE` | `TZ`, then `America/Los_Angeles` | Timezone for financial date boundaries. |
| `WEBAUTHN_RP_ID` | Hostname from `PUBLIC_ORIGIN` | Passkey relying-party ID. |
| `WEBAUTHN_ORIGIN` | `PUBLIC_ORIGIN` | Allowed WebAuthn and browser request origin. |
| `PASSKEY_CREDENTIALS_FILE` | `passkey-credentials.json` | Private passkey credential store. |

`.env.example` documents optional Splitwise credentials, sidecar path overrides, category patterns,
review thresholds, and reimbursement cutoffs.

Generate suitable secrets with:

```bash
openssl rand -hex 32
```

## Start locally

From the repository root:

```bash
set -a
source finance-dashboard/.env
set +a
npm --prefix finance-dashboard start
```

Open `http://localhost:5007` for loopback development. A live server exits if the initial Actual load
fails; clients should use the readiness endpoint rather than assuming that an open TCP port is healthy.

## Authentication

### Native app

The mobile app sends either:

```http
X-Finance-Token: <FINANCE_API_TOKEN>
```

or `Authorization: Bearer <FINANCE_API_TOKEN>` to `/api/v1/*`. Token comparisons are timing-safe.

### Browser passkey

Browser sessions authenticate through WebAuthn. First enrollment is closed by default and requires a
short-lived out-of-band code.

Generate a one-time code and its SHA-256 hash:

```bash
ENROLLMENT_CODE="$(openssl rand -hex 12)"
printf 'Enrollment code: %s\n' "$ENROLLMENT_CODE"
printf '%s' "$ENROLLMENT_CODE" | shasum -a 256
```

Set the 64-character digest as `PASSKEY_ENROLLMENT_TOKEN_HASH` and a future Unix timestamp in
milliseconds as `PASSKEY_ENROLLMENT_EXPIRES_AT`, then restart the server. For example, a 15-minute
window can be generated with:

```bash
node -e 'console.log(Date.now() + 15 * 60 * 1000)'
```

Visit `/login`, enter the original code, and register the passkey. Once a credential exists, anonymous
enrollment is rejected even if the variables remain set. Remove both enrollment variables and restart
after provisioning. Additional credentials require an already authenticated browser session.

Back up `passkey-credentials.json`, `SESSION_SECRET`, and the private sidecars. Losing the credential
file can lock browser users out.

## API behavior

- Native endpoints are under `/api/v1`.
- `/api/v1/ping` returns HTTP `200` only after Actual data is ready; otherwise it returns `503`.
- Successful ping output includes the finance timezone, process start time, Actual health, and queued
  mutation count.
- API failures use stable error codes where possible and include an `X-Request-Id`/`requestId` for log
  correlation.
- Request bodies are limited to 1 MB, except validated receipt uploads.
- Browser writes reject requests that carry an `Origin` different from the configured origin; session
  cookies are `SameSite=Lax`, secure outside loopback, and HTTP-only.
- CORS allows only the configured browser origin; native requests do not need a browser origin.
- Every authenticated `/api/v1` write requires a unique `Idempotency-Key`. Completed results replay
  safely; an operation left `started` after a crash remains outcome-unknown and is inspectable at
  `GET /api/v1/operations/:key` rather than being applied twice.
- Bank sync and `/refresh` import/read data only. They return previews for split deltas and stale pending
  charges; categorization, cleanup, reimbursement, and Splitwise-mirror writes require explicit actions.

## Demo mode

The public demo surface is synthetic and non-persistent. Demo requests never fall through to live
resolvers, and writes return simulated success without touching Actual or sidecars.

Start a demo-only process with no Actual connection:

```bash
DEMO_ONLY=1 npm start
```

Run that command from `finance-dashboard`. Native clients select demo mode with `X-Demo-Mode: 1`.
Unhandled demo endpoints fail closed. Demo requests and expensive finance routes are rate-limited.

Do not use `SELFTEST=1` as an authentication bypass outside automated loopback tests; the server rejects
it when `PUBLIC_ORIGIN` is non-local.

## Runtime sidecars

Depending on enabled features, runtime state can include:

- `personal-config.json`
- `budget-settings.json`
- `investment-holdings.json`
- `debt-planner.json`
- `owes-config.json` and `owes-truth.json`
- `venmo-truth.json`
- `events.json`
- `receipts.json` and `receipts/`
- rules, reconciliation, reimbursement-link, override, and goal stores
- `review-state.json` and `operation-journal.json`
- `passkey-credentials.json` and `.sessions/`

These files may contain sensitive financial or identity information. Keep them private and never commit
them. [`../ops/bin/backup-dashboard-runtime.sh`](../ops/bin/backup-dashboard-runtime.sh) backs up the
known durable sidecars, passkey credentials, and receipts; it intentionally excludes browser sessions
and the environment/`SESSION_SECRET`, which require separate handling.

## Tests

From this directory:

```bash
npm test
npm run lint
```

The tests cover request security, enrollment, demo isolation, schemas, dates, reports, snapshot
validation, JSON recovery, serial execution, and transaction replacement/rollback.

For a destructive mutation smoke test, use an isolated Actual clone only:

```bash
CONFIRM=1 \
CLONE_MUTATION_TEST=1 \
ACTUAL_SERVER_URL=http://127.0.0.1:15006 \
ACTUAL_PASSWORD=... \
ACTUAL_SYNC_ID=... \
ACTUAL_DATA_DIR=/tmp/actual-dashboard-smoke \
node scripts/actual-clone-smoke.js
```

The script creates, splits, edits, unsplits, and deletes test transactions. Never point it at the
production budget.

## Production operations

The reviewed service unit, environment-file contract, backups, restore safeguards, and deployment
checks are documented in [`../ops/README.md`](../ops/README.md).

## License

MIT. See [`LICENSE`](./LICENSE).

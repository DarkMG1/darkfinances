# DarkFinances API (`/api/v1`)

The native app talks to the same Express server that powers the web dashboard.
Browser requests use the
passkey/WebAuthn session; the app uses a static bearer token. Both hit the same
resolvers, so responses are identical.

- Base URL: your deployed dashboard origin, for example `https://finances.example.com`
- Versioned prefix: `/api/v1`
- The legacy unversioned `/api/*` routes still exist for the web dashboard and
  are **session-only** (no token). Native clients must use `/api/v1`.

## Auth

`/api/v1/*` accepts **either** an authenticated browser session **or** a token:

```
X-Finance-Token: <FINANCE_API_TOKEN>
# or
Authorization: Bearer <FINANCE_API_TOKEN>
```

The server compares the token with `crypto.timingSafeEqual` against
`process.env.FINANCE_API_TOKEN`. A missing/invalid token returns `401`:

```json
{ "error": "UNAUTHENTICATED" }
```

The app stores the token in `expo-secure-store` and the server URL in MMKV; the
header is attached by `src/api/client/server-auth.ts`.

## Envelope

Every `/api/v1` response is wrapped:

```json
{ "data": <payload> }          // 2xx
{ "error": "<message>" }        // non-2xx (401 unauth, 500 resolver error)
```

`buildQuery` in `src/api/client/requests.ts` unwraps `data` and throws a
`FinanceError` (carrying `.error` + `.status`) on failure.

## CORS

The router echoes `Origin`, allows `GET, POST, DELETE, OPTIONS`, allows
`Content-Type, Authorization, X-Finance-Token, X-Demo-Mode`, and short-circuits
preflight `OPTIONS` with `204`.

## Demo mode

Send `X-Demo-Mode: 1` (or `?demo=1`) on any request and the server returns a
fully synthetic dataset from `demoData.js` instead of touching Actual — for
showcasing the app without exposing real finances. It runs **after** auth, so a
valid token/session is still required; writes (`POST`/`DELETE`) return a fake
`{ ok: true }` and persist nothing. The native app exposes this via the
Settings → *Demo Mode* toggle (persisted in MMKV under `finance_demo`); the flag
is threaded through `buildQuery` and appended to every react-query key so the
cache buckets swap and refetch when toggled. The web dashboard has a matching
header toggle that appends `?demo=1` to its `/api` calls.

## Endpoints

| Method | Path | Query / Body | Returns | react-query key |
| --- | --- | --- | --- | --- |
| GET  | `/ping` | — | `Ping` `{ ok, ts }` | `ping` |
| GET  | `/accounts` | — | `Account[]` | `accounts` |
| GET  | `/transactions` | `?accountId&start&end` (dates `YYYY-MM-DD`; default = current month to today) | `Transaction[]` | `transactions` |
| GET  | `/spending` | `?month=YYYY-MM` (default current) | `Spending` | `spending` |
| GET  | `/trends` | `?months=3..36` (default 12) | `Trends` | `trends` |
| GET  | `/budgets` | `?month=YYYY-MM` (default current) | `Budgets` | `budgets` |
| GET  | `/reimbursement` | `?from&to&openOnly=1` (all optional) | `Reimbursement` | `reimbursement` |
| GET  | `/insights` | `?month=YYYY-MM` (default current) | `Insights` | `insights` |
| GET  | `/categories` | — | `Category[]` | `categories` |
| GET  | `/recurring` | `?window=6..36` (months, default 18) | `Recurring` | `recurring` |
| GET  | `/bills` | `?days=7..120` (default 45) | `Bills` | `bills` |
| GET  | `/goals` | — | `Goal[]` | `goals` |
| POST | `/transactions/:id/category` | body `{ categoryId, isLeg?, parentId?, accountId?, date? }` | `CategorizeResult` `{ ok, mode }` | `setCategory` |
| POST | `/transactions/:id/notes` | body `{ notes, isLeg?, parentId?, accountId?, date? }` | `CategorizeResult` `{ ok, mode }` | `setNotes` |
| POST | `/recurring/:key/override` | body `{ status?: 'cancelled'\|'active'\|null, hidden?: boolean }` | `{ ok, key, override }` | `setRecurringOverride` |
| POST | `/goals` | body `{ id?, name, target, accountId?, deadline? }` | `{ ok, id }` | `saveGoal` |
| DELETE | `/goals/:id` | — | `{ ok }` | `deleteGoal` |
| POST | `/refresh` | — | `{ ok: true }` (flushes cache + re-inits Actual) | `refresh` |

### Notes on specific endpoints

- **transactions**: split parents are returned alongside their legs; legs carry
  `isLeg: true` and `parentId`. Amounts are dollars (Actual stores integer
  cents; the resolver converts).
- **spending**: returns `current` + `prev` month `SpendSummary` (per-category
  map, `totalSpend`, `totalIncome`) so the app can show month-over-month deltas.
  `Money Movement` and `Reimbursement` categories are excluded from spend totals.
- **budgets**: `supported:false` when the Actual file has no budget configured
  for the month; the app falls back to a spending-only view. `pct` is `null`
  when nothing is budgeted for a category.
- **reimbursement**: `people[].status` is `owes_you | over_settled | settled`;
  `expected[]` rolls up configured reimbursement baselines (`paid | partial | open`).
- **recurring**: detects subscriptions by grouping spend by normalized payee over
  `window` months, classifying the median inter-charge gap into a `cadence`, and
  projecting `nextRenewal`. `status` is `active | inactive | cancelled`;
  `priceChange` is non-null when the latest charge differs >5% from the prior one.
  `monthlyEquivalent` normalizes any cadence to a monthly figure; `monthlyTotal`/
  `annualTotal` sum only active items. User overrides (cancel/hide) persist to
  `recurring-overrides.json` (sidecar, keyed by normalized payee).
- **bills**: projects each active recurring item's upcoming charges within `days`,
  rolling overdue dates forward. Derived purely from `/recurring` — no extra state.
- **goals**: sidecar `goals.json`. `current` tracks a linked `accountId` balance
  when set (else the stored `current`); `pct` is `current/target`. `saveGoal`
  upserts (omit `id` to create); `deleteGoal` removes by id.
- **set notes** (write): same split-aware safe-edit rule as `setCategory`
  (rebuilds the parent for split legs, preserving `imported_id`).
- **set category** (write): follows the safe-edit rule. For a split leg the
  server deletes the parent and re-adds it (preserving `imported_id`) so the
  import dedupe key survives; `mode` reports which path ran. The write is
  immediately `syncNow()`-ed back to the Actual server and the cache is flushed.

## Type definitions

Response shapes live in `src/api/generated/types.ts`; the endpoint catalog
(path + method + key) lives in `src/api/generated/endpoints.ts`. Typed hooks for
each endpoint are in `src/api/hooks/finance.hooks.ts`.

## Connectivity test

`testConnection(serverUrl, token)` (in `requests.ts`) hits `/api/v1/ping` and is
used by onboarding + settings to validate a URL/token pair before saving.

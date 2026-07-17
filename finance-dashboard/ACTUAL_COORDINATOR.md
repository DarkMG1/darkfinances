# Actual read/write coordinator (PR-13 / H5)

The finance dashboard serves cached Actual-backed aggregates over HTTP while mutations,
saga recovery, and periodic sync all touch the same non-reentrant `@actual-app/api`
instance. The coordinator is the single contract for that shared resource.

## Responsibilities

| Surface | Coordinator mode | Cache |
|--------|-------------------|-------|
| Actual-backed GET resolvers (`cachedActual`) | `runRead` | generation-scoped fill |
| Sidecar/static GET (`cachedLocal`) | none | plain NodeCache TTL |
| HTTP mutations touching Actual | `mutationQueue` → dataModule → `runWrite` | `invalidateHttpCache()` |
| Splitwise mirror preflight | `runRead` (`skipRecover: true`) | n/a |
| Saga recovery / `initApi` / `syncNow` / `shutdownApi` | `runRecover` | `syncNow` invalidates before lane release |
| Sidecar mutations affecting Actual-derived projections | `runActualProjectionMutation` (write lane through persist + invalidate) | full `invalidateActualProjection()` (generation bump + flush) |
| Sidecar mutations affecting local-only projections | none | `invalidateLocalCache(...keys)` |
| Graceful shutdown | drain mutations → `shutdownApi` → `shutdownHandoff` | n/a |

## Cache key classification

**Generation-bound (`cachedActual`)** — any key whose loader reads Actual and/or merges
Actual with sidecars. Publication is `{ generation, value }`; eviction must advance
generation via `invalidateActualProjection` or full `invalidateHttpCache`.

| Key / family | Loader notes |
|--------------|--------------|
| `accounts` | Actual accounts + override sidecar |
| `today` | Composite dashboard (accounts, spending, goals, review, …) |
| `events` | Sidecar list + Actual txn tag scan |
| `goals` | Sidecar goals + Actual account balances |
| `categories`, `tags` | Actual enumeration |
| `review-{month\|current}` | Actual txns + sidecar review/receipts/recon |
| `txns-*`, `spending-*`, `trends-*`, `budgets-*` | Actual aggregates |
| `reimb-*`, `reimb-ledger-*`, `reimb-suggest-*` | Actual + reimbursement sidecars |
| `insights-*`, `recurring-*`, `bills-*`, `forecast-*`, `income-*` | Actual-derived |
| `search-*`, `reports-*`, `mhist-*` | Actual-derived |
| Warm targets (`spending-current`, `trends-12`, …) | Same as resolver keys above |

**Local-only (`cachedLocal`)** — sidecar JSON with no live Actual merge in the loader:

| Key | Loader |
|-----|--------|
| `rules` | Rules + catalog display |
| `manual-assets` | Manual asset sidecar |
| `investments` | Investment holdings sidecar |

Never call plain `cache.del` on generation-bound keys. `invalidateActualProjection`
always bumps generation (optionally deleting named keys); stale in-flight fills are
discarded at publish time.

## Invariants

1. **Single Actual lane** — every `@actual-app/api` use runs inside `runRead`, `runWrite`, or
   `runRecover`. Nested dataModule calls reuse the active hold (`AsyncLocalStorage`).
2. **Write exclusivity** — `runWrite` advances `generation` and flushes the HTTP cache before
   the write body runs.
3. **Generation-scoped cache publication** — fills capture `generation` at read start and
   publish only if still current when the fill completes.
4. **Sync invalidation at coordinator boundary** — `syncNow` calls `invalidateGeneration()`
   inside `runRecover` after saga sync succeeds, before releasing the lane.
5. **Sidecar projection invalidation** — mutations that change Actual-derived HTTP
   projections (events, account overrides, review disposition, goals, reconciliation,
   receipts, recurring/bills horizons, reimbursement links/config, …) run through
   `runActualProjectionMutation`, which holds the coordinator write lane through
   sidecar persistence and then bumps generation. Dynamic resolver families
   (`recurring-*`, `bills-*`, `reimb-*`, `reimb-ledger-*`, `reimb-suggest-*`, …)
   use full invalidation (no exact-key list) because horizons and query params vary.
   Narrow exact-key invalidation is reserved for stable single-key projections
   (e.g. `events`, `goals`). `cachedRead` admits generation at cache miss and
   retries when publication is discarded mid-fill.
6. **HTTP mutation queue unchanged** — versioned mutations serialize on
   `SerialQueue('finance-mutations')`; coordinator serializes Actual access.
7. **Bounded diagnostics** — `/api/v1/ping` exposes `actualCoordinator` health.
8. **No raw `data.api` in production** — gated behind `ALLOW_RAW_ACTUAL_API=1` for tests.

## Reentrancy

`dataModule.withApi` may call other getters while already on the Actual lane. Only call
chains rooted in the active lane bypass re-entry; concurrent HTTP requests queue behind
the lane holder. Depth is capped at `MAX_NEST_DEPTH` (32).

## Shutdown handoff (PR-14 compatible)

HTTP read drain remains PR-14's scope. Actual shutdown ordering:

1. `mutationQueue.close()` — stop mutation admission.
2. `httpServer.close()`.
3. `mutationQueue.drain()`.
4. `data.shutdownApi()` → `shutdownHandoff`: stop admission → drain in-flight work →
   saga sync + `api.shutdown` → `shutdownFinalized` (never reopened).

The server must not call `actualCoordinator.close()` before `shutdownApi`.

## Stale-fill window

Any generation bump (`invalidateHttpCache`, `invalidateActualProjection`, `runWrite`,
`syncNow`) while an in-flight `cachedActual` fill awaits I/O discards publication of
that fill even if a maintainer removed flush-only invalidation elsewhere.

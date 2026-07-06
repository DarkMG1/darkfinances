import { dehydrate, hydrate, type QueryClient } from '@tanstack/react-query';
import { kv } from '@/lib/storage';

// Persist the React Query cache to MMKV so a cold start renders the last-known
// data instantly (no blocking spinners) while it revalidates in the background.
// Implemented with the built-in dehydrate/hydrate so we avoid an extra dependency.

const CACHE_KEY = 'rq-cache-v2';
const MAX_AGE_MS = 1000 * 60 * 60 * 24; // 24h: drop anything older than a day

type Saved = { t: number; state: unknown };

// Synchronous restore. Call once at module load, before the first render, so
// queries already have data and never flash a spinner on a warm start.
export function hydrateQueryClient(qc: QueryClient): void {
  try {
    const raw = kv.getString(CACHE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Saved;
    if (!saved || typeof saved.t !== 'number' || Date.now() - saved.t > MAX_AGE_MS) return;
    hydrate(qc, saved.state);
  } catch {
    /* corrupt/legacy cache — ignore */
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;

// Subscribe to cache changes and persist (debounced) only successful queries.
// Returns an unsubscribe function.
export function startPersistingQueryClient(qc: QueryClient): () => void {
  const persist = () => {
    try {
      const state = dehydrate(qc, {
        shouldDehydrateQuery: (q) => q.state.status === 'success',
      });
      kv.setString(CACHE_KEY, JSON.stringify({ t: Date.now(), state } satisfies Saved));
    } catch {
      /* serialize/quota error — skip this round */
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(persist, 1000);
  };
  const unsub = qc.getQueryCache().subscribe(schedule);
  return () => {
    unsub();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

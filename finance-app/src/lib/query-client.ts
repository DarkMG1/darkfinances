import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
      staleTime: 30_000,
      gcTime: 1000 * 60 * 60,
    },
    mutations: {
      retry: 0,
    },
  },
});

export async function clearFinanceQueries(): Promise<void> {
  await queryClient.cancelQueries();
  queryClient.clear();
}

export function financeServerScope(serverUrl: string | null, token: string | null, demo: boolean): string {
  const input = `${serverUrl ?? ''}\u0000${token ?? ''}\u0000${demo ? 'demo' : 'live'}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `server-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

import { useMutation, UseMutationOptions, useQuery, UseQueryOptions } from '@tanstack/react-query';
import { getServerAuthHeaders } from '@/api/client/server-auth';
import { getServerBaseUrl } from '@/api/client/server-url';
import { HttpMethod } from '@/api/generated/endpoints';
import { haptics } from '@/lib/haptics';
import { useServerConfig } from '@/state/server';

export type FinanceError = Error & { error: string; status?: number };

function createError(message: string, status?: number): FinanceError {
  const err = new Error(message) as FinanceError;
  err.error = message;
  err.status = status;
  return err;
}

interface QueryArgs<D> {
  serverUrl: string | null | undefined;
  token: string | null | undefined;
  endpoint: string;
  method: HttpMethod;
  data?: D;
  params?: Record<string, unknown>;
  demo?: boolean;
}

// Core fetch wrapper. Unwraps the { data } / { error } envelope returned by /api/v1.
export async function buildQuery<T, D = unknown>({
  serverUrl,
  token,
  endpoint,
  method,
  data,
  params,
  demo,
}: QueryArgs<D>): Promise<T | undefined> {
  const url = new URL(getServerBaseUrl(serverUrl) + endpoint);
  if (params && method === 'GET') {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) url.searchParams.append(key, String(value));
    });
  }

  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...getServerAuthHeaders(token),
      ...(demo ? { 'X-Demo-Mode': '1' } : {}),
    },
  };
  if (data && method !== 'GET') options.body = JSON.stringify(data);

  const response = await fetch(url.toString(), options);
  const text = await response.text();

  let parsed: { data?: T; error?: string } | undefined;
  if (text) {
    try {
      parsed = JSON.parse(text) as { data?: T; error?: string };
    } catch {
      if (!response.ok) throw createError(`Request failed with status ${response.status}`, response.status);
      return text as unknown as T;
    }
  }

  if (!response.ok) {
    throw createError(parsed?.error || `Request failed with status ${response.status}`, response.status);
  }
  return parsed?.data;
}

type FinanceQueryProps<R, V> = Omit<UseQueryOptions<R | undefined, FinanceError>, 'queryFn'> & {
  endpoint: string;
  method: HttpMethod;
  params?: V;
};

export function useFinanceQuery<R, V = Record<string, unknown>>({
  endpoint,
  method,
  params,
  ...options
}: FinanceQueryProps<R, V>) {
  const { serverUrl, token, demo, configured } = useServerConfig();
  // Append the demo flag so flipping demo mode swaps cache buckets + refetches.
  const queryKey = [...((options.queryKey as unknown[] | undefined) ?? []), demo ? 'demo' : 'live'];
  return useQuery<R | undefined, FinanceError>({
    queryFn: () => buildQuery<R, V>({ serverUrl, token, demo, endpoint, method, params: params as Record<string, unknown> }),
    ...options,
    queryKey,
    enabled: configured && (options.enabled ?? true),
  });
}

type FinanceMutationProps<R, V> = UseMutationOptions<R | undefined, FinanceError, V> & {
  endpoint: string | ((variables: V) => string);
  method: HttpMethod;
};

export function useFinanceMutation<R = void, V = void>({
  endpoint,
  method,
  onSuccess,
  onError,
  ...options
}: FinanceMutationProps<R, V>) {
  const { serverUrl, token, demo } = useServerConfig();
  return useMutation<R | undefined, FinanceError, V>({
    mutationFn: (variables: V) =>
      buildQuery<R, V>({
        serverUrl,
        token,
        demo,
        endpoint: typeof endpoint === 'function' ? endpoint(variables) : endpoint,
        method,
        data: variables,
      }),
    ...options,
    // Centralized haptic feedback so every write (link, note, category, goal, add
    // expense, …) confirms itself without each call site wiring it up. Args are
    // forwarded verbatim so we stay agnostic to react-query's callback arity.
    onSuccess: (...args: Parameters<NonNullable<typeof onSuccess>>) => {
      haptics.success();
      return onSuccess?.(...args);
    },
    onError: (...args: Parameters<NonNullable<typeof onError>>) => {
      haptics.warning();
      return onError?.(...args);
    },
  });
}

// Imperative connection test used by onboarding/settings.
export async function testConnection(serverUrl: string, token: string): Promise<boolean> {
  const res = await buildQuery<{ ok: boolean }>({ serverUrl, token, endpoint: '/api/v1/ping', method: 'GET' });
  return !!res?.ok;
}

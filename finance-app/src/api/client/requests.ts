import { useMutation, UseMutationOptions, useQuery, UseQueryOptions } from '@tanstack/react-query';
import { getServerAuthHeaders } from '@/api/client/server-auth';
import { getServerBaseUrl, normalizeServerUrl } from '@/api/client/server-url';
import { HttpMethod } from '@/api/generated/endpoints';
import { haptics } from '@/lib/haptics';
import { registerFinanceRequest } from '@/lib/request-lifecycle';
import { useServerConfig } from '@/state/server';

export type FinanceError = Error & { error: string; status?: number; code?: string; requestId?: string };

function createError(message: string, status?: number, code?: string, requestId?: string): FinanceError {
  const err = new Error(message) as FinanceError;
  err.error = message;
  err.status = status;
  err.code = code;
  err.requestId = requestId;
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
  signal?: AbortSignal;
  timeoutMs?: number;
  idempotencyKey?: string;
}

let mutationSequence = 0;
function createIdempotencyKey(): string {
  mutationSequence = (mutationSequence + 1) % 1_000_000;
  return `ios-${Date.now().toString(36)}-${mutationSequence.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function recoverOperation<T>(
  serverUrl: string | null | undefined,
  token: string | null | undefined,
  demo: boolean | undefined,
  key: string,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 750));
    const response = await fetch(`${getServerBaseUrl(serverUrl)}/api/v1/operations/${encodeURIComponent(key)}`, {
      headers: {
        ...getServerAuthHeaders(token),
        ...(demo ? { 'X-Demo-Mode': '1' } : {}),
      },
    });
    const envelope = await response.json() as {
      data?: { status: string; result?: T; error?: { code?: string; message?: string } };
      error?: string;
      code?: string;
    };
    if (!response.ok) throw createError(envelope.error || 'Could not check operation outcome', response.status, envelope.code);
    if (envelope.data?.status === 'completed') return envelope.data.result as T;
    if (envelope.data?.status === 'failed') {
      throw createError(envelope.data.error?.message || 'Operation failed', 409, envelope.data.error?.code);
    }
  }
  throw createError('Request outcome is still unknown. Check the operation before retrying.', 409, 'OUTCOME_UNKNOWN');
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
  signal,
  timeoutMs,
  idempotencyKey,
}: QueryArgs<D>): Promise<T | undefined> {
  const url = new URL(getServerBaseUrl(serverUrl) + endpoint);
  if (params && method === 'GET') {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) url.searchParams.append(key, String(value));
    });
  }

  const controller = new AbortController();
  const unregister = registerFinanceRequest(controller);
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const requestTimeout = timeoutMs ?? (endpoint.includes('/receipts') && method === 'POST' ? 90_000 : method === 'GET' ? 20_000 : 30_000);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, requestTimeout);

  const options: RequestInit = {
    method,
    cache: 'no-store',
    headers: {
      ...getServerAuthHeaders(token),
      ...(demo ? { 'X-Demo-Mode': '1' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    signal: controller.signal,
  };
  if (data !== undefined && method !== 'GET') {
    (options.headers as Record<string, string>)['Content-Type'] = 'application/json';
    options.body = JSON.stringify(data);
  }

  try {
    const response = await fetch(url.toString(), options);
    const text = await response.text();

    let parsed: { data?: T; error?: string; code?: string; requestId?: string } | undefined;
    if (text) {
      try {
        parsed = JSON.parse(text) as { data?: T; error?: string; code?: string; requestId?: string };
      } catch {
        if (!response.ok) throw createError(`Request failed with status ${response.status}`, response.status);
        return text as unknown as T;
      }
    }

    if (!response.ok) {
      throw createError(
        parsed?.error || `Request failed with status ${response.status}`,
        response.status,
        parsed?.code,
        parsed?.requestId,
      );
    }
    return parsed?.data;
  } catch (error) {
    if (timedOut && idempotencyKey) {
      return recoverOperation<T>(serverUrl, token, demo, idempotencyKey);
    }
    if (timedOut) throw createError('Request timed out. Check your connection and try again.', 408, 'TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    unregister();
  }
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
  const { serverUrl, token, demo, configured, scope } = useServerConfig();
  const queryKey = [...((options.queryKey as unknown[] | undefined) ?? []), scope];
  return useQuery<R | undefined, FinanceError>({
    queryFn: ({ signal }) => buildQuery<R, V>({
      serverUrl,
      token,
      demo,
      endpoint,
      method,
      params: params as Record<string, unknown>,
      signal,
    }),
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
        idempotencyKey: demo ? undefined : createIdempotencyKey(),
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
export async function testConnection(serverUrl: string, token: string, demo = false): Promise<boolean> {
  const normalizedUrl = normalizeServerUrl(serverUrl);
  const res = await buildQuery<{ ok: boolean }>({ serverUrl: normalizedUrl, token, demo, endpoint: '/api/v1/ping', method: 'GET' });
  return !!res?.ok;
}

export interface VerifiedServerConfig {
  serverUrl: string;
  token: string;
  demo: boolean;
}

export async function verifyConnectionConfig(input: {
  serverUrl: string;
  token: string;
  demo?: boolean;
}): Promise<VerifiedServerConfig> {
  const candidate: VerifiedServerConfig = {
    serverUrl: normalizeServerUrl(input.serverUrl),
    token: input.token.trim(),
    demo: !!input.demo,
  };
  if (!candidate.token) throw createError('Enter an API token.');
  const ok = await testConnection(candidate.serverUrl, candidate.token, candidate.demo);
  if (!ok) throw createError(candidate.demo ? 'Demo server did not confirm' : 'Server did not confirm');
  return candidate;
}

import { useMutation, UseMutationOptions, useQuery, UseQueryOptions } from '@tanstack/react-query';
import { getServerAuthHeaders } from '@/api/client/server-auth';
import { getServerBaseUrl, normalizeServerUrl } from '@/api/client/server-url';
import { HttpMethod } from '@/api/generated/endpoints';
import { financeOperationMachine, financeOperationProfileScope } from '@/lib/finance-operations';
import { FINANCE_QUERY_SCOPE_META_KEY } from '@/lib/foreground-operation-reconciliation';
import { mutationOutcomeHaptics } from '@/lib/haptics';
import { registerFinanceRequest } from '@/lib/request-lifecycle';
import {
  classifyDirectMutationError,
  DirectMutationOutcome,
  executeMutationWithIdempotency,
  REACT_QUERY_MUTATION_RETRY,
  ServerOperationStatus,
} from '@/lib/request-operation-state';
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

async function queryOperationStatus<T>(
  serverUrl: string | null | undefined,
  token: string | null | undefined,
  key: string,
): Promise<ServerOperationStatus<T>> {
  const status = await buildQuery<ServerOperationStatus<T>>({
    serverUrl,
    token,
    endpoint: `/api/v1/operations/${encodeURIComponent(key)}`,
    method: 'GET',
  });
  if (!status) throw createError('Could not read operation status', 502, 'MALFORMED_RESPONSE');
  return status;
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
        if (method !== 'GET') {
          throw createError('Server returned a malformed mutation response', response.status, 'MALFORMED_RESPONSE');
        }
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
    if (method !== 'GET' && (!parsed || !Object.prototype.hasOwnProperty.call(parsed, 'data'))) {
      throw createError('Server returned a malformed mutation response', response.status, 'MALFORMED_RESPONSE');
    }
    return parsed?.data;
  } catch (error) {
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
    meta: {
      ...options.meta,
      [FINANCE_QUERY_SCOPE_META_KEY]: scope,
    },
    enabled: configured && (options.enabled ?? true),
  });
}

type FinanceMutationProps<R, V> = UseMutationOptions<R | undefined, FinanceError, V> & {
  endpoint: string | ((variables: V) => string);
  method: HttpMethod;
  /** When true, success/warning outcome haptics are suppressed (background/non-user writes). */
  suppressOutcomeHaptic?: boolean;
};

function deriveMutationRequestDigest(
  scopeDigest: string | null,
  endpoint: string,
  method: HttpMethod,
  variables: unknown,
): string | null {
  if (!scopeDigest) return null;
  return financeOperationMachine.deriveRequestDigest({
    scopeDigest,
    method,
    endpoint,
    body: variables,
  });
}

export function useFinanceMutation<R = void, V = void>({
  endpoint,
  method,
  onSuccess,
  onError,
  suppressOutcomeHaptic = false,
  ...options
}: FinanceMutationProps<R, V>) {
  const { serverUrl, token, demo } = useServerConfig();
  return useMutation<R | undefined, FinanceError, V>({
    ...options,
    mutationFn: (variables: V) => {
      const resolvedEndpoint = typeof endpoint === 'function' ? endpoint(variables) : endpoint;
      const scopeDigest = financeOperationProfileScope(serverUrl, token, demo);
      if (!demo && !scopeDigest) {
        throw createError('Finance server profile is not configured', 400, 'PROFILE_NOT_CONFIGURED');
      }
      const requestDigest = demo
        ? null
        : deriveMutationRequestDigest(scopeDigest, resolvedEndpoint, method, variables);
      const preparedOperation = !demo && scopeDigest
        ? financeOperationMachine.prepare({
            scopeDigest,
            endpoint: resolvedEndpoint,
            method,
            body: variables,
          })
        : null;
      if (!suppressOutcomeHaptic && preparedOperation) {
        mutationOutcomeHaptics.beginUserMutation(requestDigest, {
          userInitiated: true,
          operationKey: preparedOperation.idempotencyKey,
          scopeDigest,
        });
      }
      return executeMutationWithIdempotency<R | undefined>({
        demo,
        machine: financeOperationMachine,
        demoDispatch: () => buildQuery<R, V>({
          serverUrl,
          token,
          demo: true,
          endpoint: resolvedEndpoint,
          method,
          data: variables,
        }),
        operation: {
          scopeDigest: scopeDigest ?? '',
          endpoint: resolvedEndpoint,
          method,
          body: variables,
          dispatch: async (idempotencyKey): Promise<DirectMutationOutcome<R | undefined>> => {
            try {
              const result = await buildQuery<R, V>({
                serverUrl,
                token,
                endpoint: resolvedEndpoint,
                method,
                data: variables,
                idempotencyKey,
              });
              return { kind: 'completed', result };
            } catch (error) {
              return classifyDirectMutationError(error);
            }
          },
          queryStatus: (idempotencyKey) =>
            queryOperationStatus<R | undefined>(serverUrl, token, idempotencyKey),
        },
      });
    },
    retry: REACT_QUERY_MUTATION_RETRY,
    // Centralized mutation outcome haptics (L5): one success or error haptic per
    // logical user mutation. Callers must not duplicate these in onSuccess/onError.
    onSuccess: (...args: Parameters<NonNullable<typeof onSuccess>>) => {
      const [, variables] = args;
      const resolvedEndpoint = typeof endpoint === 'function' ? endpoint(variables as V) : endpoint;
      const scopeDigest = financeOperationProfileScope(serverUrl, token, demo);
      if (demo) {
        if (!suppressOutcomeHaptic) mutationOutcomeHaptics.emitDemoSuccess();
      } else {
        const requestDigest = deriveMutationRequestDigest(
          scopeDigest,
          resolvedEndpoint,
          method,
          variables,
        );
        if (!suppressOutcomeHaptic) mutationOutcomeHaptics.emitSuccess(requestDigest);
      }
      return onSuccess?.(...args);
    },
    onError: (...args: Parameters<NonNullable<typeof onError>>) => {
      const [error, variables] = args;
      const resolvedEndpoint = typeof endpoint === 'function' ? endpoint(variables as V) : endpoint;
      const scopeDigest = financeOperationProfileScope(serverUrl, token, demo);
      if (demo) {
        if (!suppressOutcomeHaptic) mutationOutcomeHaptics.emitDemoError(error);
      } else {
        const requestDigest = deriveMutationRequestDigest(
          scopeDigest,
          resolvedEndpoint,
          method,
          variables,
        );
        if (!suppressOutcomeHaptic) mutationOutcomeHaptics.emitError(requestDigest, error);
      }
      return onError?.(...args);
    },
  });
}

export async function reconcilePendingFinanceOperations(config: {
  serverUrl: string | null | undefined;
  token: string | null | undefined;
  demo: boolean;
}): Promise<{ checked: number; completed: number; failed: number; unresolved: number }> {
  const scopeDigest = financeOperationProfileScope(config.serverUrl, config.token, config.demo);
  if (!scopeDigest) return { checked: 0, completed: 0, failed: 0, unresolved: 0 };
  return financeOperationMachine.reconcileProfile(
    scopeDigest,
    (idempotencyKey) => queryOperationStatus<unknown>(config.serverUrl, config.token, idempotencyKey),
  );
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

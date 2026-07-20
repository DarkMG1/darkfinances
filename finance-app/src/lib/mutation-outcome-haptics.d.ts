import type { FinanceError } from '@/api/client/requests';

export interface MutationOutcomeHapticSession {
  userInitiated: boolean;
  emitted: 'success' | 'error' | null;
  scopeDigest: string | null;
  lastAccessAt: number;
}

export interface BeginUserMutationOptions {
  operationKey?: string;
  scopeDigest?: string | null;
  userInitiated?: boolean;
}

export interface MutationOutcomeHapticGateOptions {
  maxSessions?: number;
  unknownSessionTtlMs?: number;
  now?: () => number;
}

export interface MutationOutcomeHapticGate {
  reset(): void;
  purgeScope(scopeDigest: string | null | undefined): void;
  sessions(): Map<string, MutationOutcomeHapticSession>;
  beginUserMutation(
    requestDigest: string | null | undefined,
    options?: BeginUserMutationOptions,
  ): boolean;
  shouldEmitSuccess(requestDigest: string | null | undefined): boolean;
  shouldEmitError(requestDigest: string | null | undefined, error: FinanceError | unknown): boolean;
  emitSuccess(requestDigest: string | null | undefined): boolean;
  emitError(requestDigest: string | null | undefined, error: FinanceError | unknown): boolean;
  emitDemoSuccess(): boolean;
  emitDemoError(error: FinanceError | unknown): boolean;
  emitClientValidationError(): boolean;
}

export declare const DEFAULT_MAX_SESSIONS: number;
export declare const DEFAULT_UNKNOWN_SESSION_TTL_MS: number;
export declare const NON_TERMINAL_OUTCOME_CODES: ReadonlySet<string>;
export declare function isTerminalMutationError(error: unknown): boolean;
export declare function createMutationOutcomeHapticGate(
  hapticsApi: {
    success: () => void;
    warning: () => void;
  },
  options?: MutationOutcomeHapticGateOptions,
): MutationOutcomeHapticGate;

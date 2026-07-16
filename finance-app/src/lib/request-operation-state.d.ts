export type PendingOperationState = 'prepared' | 'dispatching' | 'outcome_unknown';

export interface PendingOperationRecord {
  version: 1;
  requestDigest: string;
  scopeDigest: string;
  idempotencyKey: string;
  state: PendingOperationState;
  createdAt: number;
  updatedAt: number;
  dispatchStartedAt?: number;
  outcomeUnknownAt?: number;
}

export interface PendingOperationSnapshot {
  version: 1;
  generation: number;
  operations: Record<string, PendingOperationRecord>;
}

export interface OperationIdentityInput {
  scopeDigest: string;
  method: string;
  endpoint: string;
  body?: unknown;
}

export interface TerminalOperationError {
  status: number;
  code: string;
  message: string;
}

export interface RedactedReconciliationDiagnostic {
  code: string;
  status: number;
  timestamp: number;
}

export type DirectMutationOutcome<T> =
  | { kind: 'completed'; result: T }
  | { kind: 'failed'; error: TerminalOperationError }
  | { kind: 'outcome_unknown' };

export type ServerOperationStatus<T> =
  | { status: 'completed'; phase?: 'completed'; result: T; provisionalResult?: unknown }
  | { status: 'failed'; phase?: 'failed'; error: TerminalOperationError }
  | {
    status: 'started';
    phase?: 'started' | 'local_applied' | 'sync_unknown' | string;
    provisionalResult?: unknown;
  };

export interface OperationExecution<T> extends OperationIdentityInput {
  dispatch: (idempotencyKey: string) => Promise<DirectMutationOutcome<T>>;
  queryStatus: (idempotencyKey: string) => Promise<ServerOperationStatus<T>>;
}

export interface RequestOperationStore {
  read: () => PendingOperationSnapshot | null;
  write: (snapshot: PendingOperationSnapshot) => void;
}

export interface RequestOperationMachine {
  clear: (requestDigest: string) => void;
  deriveRequestDigest: (input: OperationIdentityInput) => string;
  execute: <T>(input: OperationExecution<T>) => Promise<T>;
  listRecords: (scopeDigest?: string) => PendingOperationRecord[];
  markDispatching: (requestDigest: string) => PendingOperationRecord;
  markOutcomeUnknown: (requestDigest: string) => PendingOperationRecord | null;
  prepare: (input: OperationIdentityInput) => PendingOperationRecord;
  prepareProfilePurge: (scopeDigest?: string) => void;
  reconcileProfile: (
    scopeDigest: string,
    queryStatus: (idempotencyKey: string) => Promise<ServerOperationStatus<unknown>>,
  ) => Promise<{ checked: number; completed: number; failed: number; unresolved: number }>;
}

export class RequestOperationError extends Error {
  error: string;
  status?: number;
  code?: string;
}

export const OPERATION_STATES: Readonly<{
  PREPARED: 'prepared';
  DISPATCHING: 'dispatching';
  OUTCOME_UNKNOWN: 'outcome_unknown';
}>;
export const OUTCOME_UNKNOWN_MESSAGE: string;
export const REACT_QUERY_MUTATION_RETRY: 0;

export function canonicalEndpoint(endpoint: string): {
  pathname: string;
  query: [string, string][];
};
export function canonicalJson(value: unknown): string;
export function classifyDirectMutationError(error: unknown): DirectMutationOutcome<never>;
export function createRedactedReconciliationDiagnostic(
  error: unknown,
  now?: () => number,
): RedactedReconciliationDiagnostic;
export function createReconciliationDiagnosticStore(
  storage: {
    read: () => string | null;
    write: (value: string | null) => void;
  },
  now?: () => number,
): {
  record: (error: unknown) => void;
  get: () => RedactedReconciliationDiagnostic | null;
  clear: () => void;
};
export function deriveRequestDigest(
  input: OperationIdentityInput,
  hash: (value: string) => string,
): string;
export function createRequestOperationMachine(dependencies: {
  store: RequestOperationStore;
  hash: (value: string) => string;
  keyFactory: (input: {
    requestDigest: string;
    scopeDigest: string;
    createdAt: number;
    generation: number;
  }) => string;
  now?: () => number;
}): RequestOperationMachine;
export function executeMutationWithIdempotency<T>(input: {
  demo: boolean;
  machine: RequestOperationMachine;
  demoDispatch: () => Promise<T>;
  operation: OperationExecution<T>;
}): Promise<T>;

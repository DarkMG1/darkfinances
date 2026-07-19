export type MutationOutcomeKind =
  | 'client_validation'
  | 'validation'
  | 'offline'
  | 'timeout'
  | 'sync_unknown'
  | 'auth'
  | 'server_unavailable'
  | 'admission_retry'
  | 'conflict_stale'
  | 'conflict_saga'
  | 'conflict_ownership'
  | 'terminal';

export type MutationActionKind = 'retry_same_key' | 'refetch';

export interface MutationFormAction {
  label: string;
  kind: MutationActionKind;
}

export interface MappedMutationOutcome {
  kind: MutationOutcomeKind;
  recoverable: boolean;
  retryable: boolean;
  requiresRefetch: boolean;
  closeOnSuccess: boolean;
  summary: string;
  fieldErrors: Record<string, string>;
  firstField: string | null;
  action: MutationFormAction | null;
  announce: string;
}

export function mapMutationApiError(
  error: unknown,
  options?: {
    fieldPathOverrides?: Record<string, string>;
    fieldOrder?: string[];
    mutationLabel?: string;
  },
): MappedMutationOutcome;

export function mapClientValidationOutcome(
  fieldErrors: Record<string, string>,
  fieldOrder?: string[],
): MappedMutationOutcome;

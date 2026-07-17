import { useCallback, useState } from 'react';
import type { FinanceError } from '@/api/client/requests';
import { mapMutationApiError } from '@/lib/mutation-form-errors';
import type { MappedMutationOutcome } from '@/lib/mutation-form-errors';

export function useScreenMutationFeedback(options?: {
  mutationLabel?: string;
  onRefetch?: () => void | Promise<unknown>;
  fieldPathOverrides?: Record<string, string>;
  fieldOrder?: string[];
}) {
  const [outcome, setOutcome] = useState<MappedMutationOutcome | null>(null);
  const [announce, setAnnounce] = useState('');

  const reportError = useCallback((error: FinanceError, label?: string) => {
    const mapped = mapMutationApiError(error, {
      mutationLabel: label ?? options?.mutationLabel ?? 'Update',
      fieldPathOverrides: options?.fieldPathOverrides,
      fieldOrder: options?.fieldOrder,
    });
    setOutcome(mapped);
    setAnnounce(mapped.announce);
    if (mapped.requiresRefetch) void options?.onRefetch?.();
    return mapped;
  }, [options]);

  const reportClientValidation = useCallback((summary: string, fieldErrors: Record<string, string> = {}) => {
    const mapped = mapMutationApiError(
      { error: summary, status: 400, code: 'INVALID_REQUEST', issues: Object.entries(fieldErrors).map(([path, message]) => ({ path, message })) } as FinanceError,
      { mutationLabel: options?.mutationLabel ?? 'Update', fieldOrder: options?.fieldOrder },
    );
    setOutcome({ ...mapped, kind: 'client_validation', summary });
    setAnnounce(summary);
    return mapped;
  }, [options]);

  const clear = useCallback(() => {
    setOutcome(null);
    setAnnounce('');
  }, []);

  const reportSuccess = useCallback((label?: string) => {
    setOutcome(null);
    setAnnounce(`${label ?? options?.mutationLabel ?? 'Update'} succeeded.`);
  }, [options?.mutationLabel]);

  return { outcome, announce, reportError, reportClientValidation, reportSuccess, clear };
}

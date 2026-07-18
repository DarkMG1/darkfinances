import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import type { FinanceError } from '@/api/client/requests';
import { mapClientValidationOutcome, mapMutationApiError } from '@/lib/mutation-form-errors';
import type { MappedMutationOutcome } from '@/lib/mutation-form-errors';
import {
  clearMutationFormDraft,
  getMutationFormDraft,
  setMutationFormDraft,
} from '@/lib/mutation-form-draft-store';
import { hapticClientValidationRejected } from '@/lib/haptics';
import { getProfileGeneration } from '@/lib/notification-reconciliation';
import { runStaleRefetch, staleConflictNotice } from '@/lib/mutation-refetch';
import { useServerConfig } from '@/state/server';

export type MutationFormPhase = 'idle' | 'submitting' | 'reconciling' | 'success' | 'error';

export interface UseMutationFormOptions<TFields extends Record<string, unknown>, TVariables> {
  formId: string;
  fields: TFields;
  setFields: React.Dispatch<React.SetStateAction<TFields>>;
  mutation: UseMutationResult<unknown, FinanceError, TVariables>;
  buildVariables: (fields: TFields) => TVariables;
  validate?: (fields: TFields) => Record<string, string>;
  fieldOrder?: string[];
  fieldPathOverrides?: Record<string, string>;
  mutationLabel?: string;
  onSuccessClose?: () => void;
  onRefetch?: () => void | Promise<unknown>;
  persistDraft?: boolean;
  fieldRefs?: Partial<Record<keyof TFields, React.RefObject<{ focus?: () => void } | null>>>;
}

export interface UseMutationFormResult<TFields extends Record<string, unknown>> {
  phase: MutationFormPhase;
  outcome: MappedMutationOutcome | null;
  fieldErrors: Partial<Record<keyof TFields, string>>;
  summary: string | null;
  isLocked: boolean;
  canDismiss: boolean;
  announce: string;
  submit: () => void;
  retry: () => void;
  clearErrors: () => void;
  requestDismiss: () => boolean;
  focusFirstInvalid: () => void;
  getFieldError: (field: keyof TFields) => string | undefined;
  getFieldA11y: (field: keyof TFields, label: string) => {
    accessibilityLabel: string;
    accessibilityHint?: string;
  };
}

function focusRef(ref?: React.RefObject<{ focus?: () => void } | null>) {
  ref?.current?.focus?.();
}

export function useMutationForm<TFields extends Record<string, unknown>, TVariables>({
  formId,
  fields,
  setFields,
  mutation,
  buildVariables,
  validate,
  fieldOrder = [],
  fieldPathOverrides,
  mutationLabel = 'Save',
  onSuccessClose,
  onRefetch,
  persistDraft = true,
  fieldRefs = {},
}: UseMutationFormOptions<TFields, TVariables>): UseMutationFormResult<TFields> {
  const { scope, demo } = useServerConfig();
  const scopeDigest = demo ? 'demo' : scope;
  const profileGeneration = demo ? 0 : getProfileGeneration();
  const [phase, setPhase] = useState<MutationFormPhase>('idle');
  const [outcome, setOutcome] = useState<MappedMutationOutcome | null>(null);
  const [announce, setAnnounce] = useState('');
  const [dispatchPending, setDispatchPending] = useState(false);
  const closedRef = useRef(false);
  const variablesRef = useRef<TVariables | null>(null);
  /** Synchronous guard before React Query marks the mutation pending. */
  const pendingLockRef = useRef(false);

  useEffect(() => {
    if (!persistDraft) return;
    const draft = getMutationFormDraft(scopeDigest, formId, profileGeneration);
    if (draft) setFields((prev) => ({ ...prev, ...draft }));
  }, [formId, persistDraft, profileGeneration, scopeDigest, setFields]);

  useEffect(() => {
    if (!persistDraft) return;
    setMutationFormDraft(scopeDigest, formId, fields, profileGeneration);
  }, [fields, formId, persistDraft, profileGeneration, scopeDigest]);

  const isLocked = mutation.isPending || dispatchPending || phase === 'submitting' || phase === 'reconciling';

  const fieldErrors = useMemo(() => {
    if (!outcome?.fieldErrors) return {} as Partial<Record<keyof TFields, string>>;
    return outcome.fieldErrors as Partial<Record<keyof TFields, string>>;
  }, [outcome]);

  const focusFirstInvalid = useCallback(() => {
    const target = outcome?.firstField as keyof TFields | undefined;
    if (target && fieldRefs[target]) {
      focusRef(fieldRefs[target]);
      return;
    }
    for (const field of fieldOrder) {
      if (outcome?.fieldErrors?.[field] && fieldRefs[field as keyof TFields]) {
        focusRef(fieldRefs[field as keyof TFields]);
        return;
      }
    }
  }, [fieldOrder, fieldRefs, outcome]);

  const handleError = useCallback(async (error: FinanceError) => {
    const mapped = mapMutationApiError(error, { fieldPathOverrides, fieldOrder, mutationLabel });
    setOutcome(mapped);
    setPhase('error');
    setAnnounce(mapped.announce);
    if (mapped.requiresRefetch) {
      const ok = await runStaleRefetch(onRefetch);
      if (ok && (mapped.kind === 'conflict_stale' || mapped.kind === 'conflict_saga' || mapped.kind === 'conflict_ownership')) {
        setOutcome({ ...mapped, summary: staleConflictNotice(mapped.summary) });
      }
    }
    requestAnimationFrame(() => focusFirstInvalid());
  }, [fieldOrder, fieldPathOverrides, focusFirstInvalid, mutationLabel, onRefetch]);

  const runMutation = useCallback((variables: TVariables) => {
    variablesRef.current = variables;
    closedRef.current = false;
    pendingLockRef.current = true;
    setDispatchPending(true);
    setPhase(mutation.isPending ? 'submitting' : 'reconciling');
    setOutcome(null);
    mutation.mutate(variables, {
      onSuccess: () => {
        variablesRef.current = null;
        pendingLockRef.current = false;
        setDispatchPending(false);
        setPhase('success');
        setAnnounce(`${mutationLabel} succeeded.`);
        clearMutationFormDraft(scopeDigest, formId, profileGeneration);
        if (!closedRef.current) {
          closedRef.current = true;
          onSuccessClose?.();
        }
      },
      onError: (error) => {
        pendingLockRef.current = false;
        setDispatchPending(false);
        handleError(error);
      },
    });
  }, [formId, handleError, mutation, mutationLabel, onSuccessClose, profileGeneration, scopeDigest]);

  const submit = useCallback(() => {
    if (pendingLockRef.current || mutation.isPending || phase === 'submitting' || phase === 'reconciling') return;
    if (validate) {
      const clientErrors = validate(fields);
      if (Object.keys(clientErrors).length) {
        const mapped = mapClientValidationOutcome(clientErrors, fieldOrder);
        setOutcome(mapped);
        setPhase('error');
        setAnnounce(mapped.announce);
        hapticClientValidationRejected();
        requestAnimationFrame(() => focusFirstInvalid());
        return;
      }
    }
    runMutation(buildVariables(fields));
  }, [buildVariables, fieldOrder, fields, focusFirstInvalid, mutation.isPending, phase, runMutation, validate]);

  const retry = useCallback(() => {
    if (pendingLockRef.current || mutation.isPending || phase === 'submitting' || phase === 'reconciling') return;
    if (variablesRef.current != null) {
      runMutation(variablesRef.current);
      return;
    }
    submit();
  }, [mutation.isPending, phase, runMutation, submit]);

  const clearErrors = useCallback(() => {
    setOutcome(null);
    setPhase('idle');
    setAnnounce('');
  }, []);

  const requestDismiss = useCallback(() => {
    if (isLocked) return false;
    clearMutationFormDraft(scopeDigest, formId, profileGeneration);
    clearErrors();
    return true;
  }, [clearErrors, formId, isLocked, profileGeneration, scopeDigest]);

  const getFieldError = useCallback((field: keyof TFields) => fieldErrors[field], [fieldErrors]);

  const getFieldA11y = useCallback((field: keyof TFields, label: string) => {
    const err = fieldErrors[field];
    return {
      accessibilityLabel: label,
      accessibilityHint: err ? `Error: ${err}` : undefined,
    };
  }, [fieldErrors]);

  return {
    phase,
    outcome,
    fieldErrors,
    summary: outcome?.summary ?? null,
    isLocked,
    canDismiss: !isLocked,
    announce,
    submit,
    retry,
    clearErrors,
    requestDismiss,
    focusFirstInvalid,
    getFieldError,
    getFieldA11y,
  };
}

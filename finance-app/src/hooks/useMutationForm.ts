import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
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
  isDirty: boolean;
  activitySeq: number;
  canDismiss: boolean;
  announce: string;
  submit: () => void;
  retry: () => void;
  clearErrors: () => void;
  requestDismiss: (onConfirmed?: () => void) => boolean;
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

function fieldsEqual(a: Record<string, unknown>, b: Record<string, unknown>) {
  return JSON.stringify(a) === JSON.stringify(b);
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
  const [activitySeq, setActivitySeq] = useState(0);
  const [baseline, setBaseline] = useState(fields);
  const closedRef = useRef(false);
  const variablesRef = useRef<TVariables | null>(null);
  const pendingLockRef = useRef(false);
  const activitySeqRef = useRef(0);

  const bumpActivity = useCallback(() => {
    activitySeqRef.current += 1;
    setActivitySeq(activitySeqRef.current);
    return activitySeqRef.current;
  }, []);

  useEffect(() => {
    const draft = persistDraft ? getMutationFormDraft(scopeDigest, formId, profileGeneration) : null;
    setFields((prev) => {
      const next = draft ? { ...prev, ...draft } : prev;
      setBaseline(next);
      return next;
    });
    // Form identity reset: rehydrate draft and clear stale mutation UI when formId/scope changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on identity change
    setOutcome(null);
    setPhase('idle');
    setAnnounce('');
    variablesRef.current = null;
  }, [formId, persistDraft, profileGeneration, scopeDigest, setFields]);

  useEffect(() => {
    if (!persistDraft) return;
    setMutationFormDraft(scopeDigest, formId, fields, profileGeneration);
  }, [fields, formId, persistDraft, profileGeneration, scopeDigest]);

  const isLocked = mutation.isPending || dispatchPending || phase === 'submitting' || phase === 'reconciling';
  const isDirty = useMemo(() => !fieldsEqual(fields, baseline), [baseline, fields]);

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

  const handleError = useCallback(async (
    error: FinanceError,
    capturedScope: string,
    capturedGeneration: number,
  ) => {
    if (capturedScope !== scopeDigest || capturedGeneration !== profileGeneration) return;
    const mapped = mapMutationApiError(error, { fieldPathOverrides, fieldOrder, mutationLabel });
    setOutcome(mapped);
    setPhase('error');
    setAnnounce(mapped.announce);
    if (mapped.requiresRefetch) {
      const ok = await runStaleRefetch(onRefetch);
      if (capturedScope !== scopeDigest || capturedGeneration !== profileGeneration) return;
      if (ok && (mapped.kind === 'conflict_stale' || mapped.kind === 'conflict_saga' || mapped.kind === 'conflict_ownership')) {
        setOutcome({ ...mapped, summary: staleConflictNotice(mapped.summary) });
      }
    }
    requestAnimationFrame(() => focusFirstInvalid());
  }, [fieldOrder, fieldPathOverrides, focusFirstInvalid, mutationLabel, onRefetch, profileGeneration, scopeDigest]);

  const finalizeDismiss = useCallback((onConfirmed?: () => void) => {
    clearMutationFormDraft(scopeDigest, formId, profileGeneration);
    setOutcome(null);
    setPhase('idle');
    setAnnounce('');
    variablesRef.current = null;
    setBaseline(fields);
    onConfirmed?.();
  }, [fields, formId, profileGeneration, scopeDigest]);

  const runMutation = useCallback((variables: TVariables) => {
    const capturedScope = scopeDigest;
    const capturedGeneration = profileGeneration;
    variablesRef.current = variables;
    closedRef.current = false;
    pendingLockRef.current = true;
    bumpActivity();
    setDispatchPending(true);
    setPhase(mutation.isPending ? 'submitting' : 'reconciling');
    setOutcome(null);
    mutation.mutate(variables, {
      onSuccess: () => {
        if (capturedScope !== scopeDigest || capturedGeneration !== profileGeneration) return;
        variablesRef.current = null;
        setPhase('success');
        setAnnounce(`${mutationLabel} succeeded.`);
        clearMutationFormDraft(capturedScope, formId, capturedGeneration);
        if (!closedRef.current) {
          closedRef.current = true;
          onSuccessClose?.();
        }
      },
      onError: (error) => {
        void handleError(error, capturedScope, capturedGeneration);
      },
      onSettled: () => {
        if (capturedScope !== scopeDigest || capturedGeneration !== profileGeneration) return;
        pendingLockRef.current = false;
        setDispatchPending(false);
      },
    });
  }, [bumpActivity, formId, handleError, mutation, mutationLabel, onSuccessClose, profileGeneration, scopeDigest]);

  const submit = useCallback(() => {
    if (pendingLockRef.current || mutation.isPending || phase === 'submitting' || phase === 'reconciling') return;
    if (validate) {
      const clientErrors = validate(fields);
      if (Object.keys(clientErrors).length) {
        bumpActivity();
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
  }, [buildVariables, bumpActivity, fieldOrder, fields, focusFirstInvalid, mutation.isPending, phase, runMutation, validate]);

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
    variablesRef.current = null;
  }, []);

  const requestDismiss = useCallback((onConfirmed?: () => void) => {
    if (isLocked) return false;
    if (isDirty) {
      Alert.alert(
        'Discard unsaved changes?',
        'Your edits will be lost.',
        [
          { text: 'Keep editing', style: 'cancel' },
          {
            text: 'Discard',
            style: 'destructive',
            onPress: () => finalizeDismiss(onConfirmed),
          },
        ],
      );
      return false;
    }
    finalizeDismiss(onConfirmed);
    return true;
  }, [finalizeDismiss, isDirty, isLocked]);

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
    isDirty,
    activitySeq,
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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { nextMutationActivationSeq } from '@/lib/mutation-activation-sequence';
import {
  buildMutationFormIdentityKey,
  shouldPersistMutationFormDraft,
  shouldTreatMutationFormAsDirty,
} from '@/lib/mutation-form-hydration';
import { hapticClientValidationRejected } from '@/lib/haptics';
import { runStaleRefetch, staleConflictNotice } from '@/lib/mutation-refetch';
import { resolveMutationFormBaseline } from '@/lib/mutation-form-baseline';
import { mutationFieldsEqual } from '@/lib/mutation-fields-equal';
import {
  awaitMutationErrorReconciliation,
  startMutationErrorReconciliation,
} from '@/lib/mutation-error-reconciliation';
import {
  nextDismissRequest,
  shouldApplyFormDismiss,
} from '@/lib/mutation-form-dismiss';
import {
  captureValidationFieldSnapshot,
  shouldInvalidateValidationOutcome,
} from '@/lib/mutation-form-validation-invalidation.js';
import {
  shouldRunDeferredSuccessClose,
  shouldScheduleDeferredSuccessClose,
} from '@/lib/mutation-success-close.js';
import { useMutationAdmissionLifecycle } from '@/hooks/useMutationAdmissionLifecycle';
import { useMutationHookIdentity } from '@/hooks/useMutationHookIdentity';
import type { MutationDispatchToken } from '@/hooks/useMutationHookIdentity';
import type { MutationAdmissionRef } from '@/hooks/useMutationScreenAdmission';

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
  admissionRef?: MutationAdmissionRef;
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
  admissionRef,
}: UseMutationFormOptions<TFields, TVariables>): UseMutationFormResult<TFields> {
  const identity = useMutationHookIdentity({ formId });
  const {
    scopeDigest,
    profileGeneration,
    identityKey,
    dispatchPending,
    setDispatchPending,
    captureDispatchToken,
    isDispatchTokenCurrent,
    isPendingLocked,
  } = identity;
  const pendingLockRef = identity.pendingLockRef as React.MutableRefObject<boolean>;
  const { acquireAdmission, releaseAdmissionForLease } = useMutationAdmissionLifecycle(admissionRef, identityKey);

  const formIdentityKey = useMemo(
    () => buildMutationFormIdentityKey(scopeDigest, profileGeneration, formId),
    [formId, profileGeneration, scopeDigest],
  );

  const [phase, setPhase] = useState<MutationFormPhase>('idle');
  const [outcome, setOutcome] = useState<MappedMutationOutcome | null>(null);
  const [announce, setAnnounce] = useState('');
  const [activitySeq, setActivitySeq] = useState(0);
  const [baseline, setBaseline] = useState(fields);
  const [hydrationReadyIdentity, setHydrationReadyIdentity] = useState<string | null>(null);
  const fieldsRef = useRef(fields);
  const setFieldsRef = useRef(setFields);
  const closedRef = useRef(false);
  const variablesRef = useRef<TVariables | null>(null);
  const submittedFieldsRef = useRef<TFields | null>(null);
  const rebaselineAfterSuccessRef = useRef(false);
  const suppressPersistRef = useRef(false);
  const hydrationTargetRef = useRef<{ identity: string; target: TFields } | null>(null);
  const dismissSeqRef = useRef({ value: 0 });
  const successClosePendingRef = useRef(false);
  const successCloseTokenRef = useRef<MutationDispatchToken | null>(null);
  const successCloseCallbackRef = useRef<(() => void) | undefined>(undefined);
  const successCloseFrameRef = useRef<number | null>(null);
  const onSuccessCloseRef = useRef(onSuccessClose);

  const bumpActivity = useCallback(() => {
    const seq = nextMutationActivationSeq();
    setActivitySeq(seq);
    return seq;
  }, []);

  useEffect(() => {
    fieldsRef.current = fields;
  }, [fields]);

  useEffect(() => {
    setFieldsRef.current = setFields;
  }, [setFields]);

  useEffect(() => {
    onSuccessCloseRef.current = onSuccessClose;
  }, [onSuccessClose]);

  useEffect(() => {
    const shouldCloseSucceededForm = successClosePendingRef.current && !closedRef.current;
    const closeSucceededForm = successCloseCallbackRef.current;
    const draft = persistDraft ? getMutationFormDraft(scopeDigest, formId, profileGeneration) : null;
    const next = resolveMutationFormBaseline(fieldsRef.current, draft) as TFields;
    setBaseline(next);
    hydrationTargetRef.current = { identity: formIdentityKey, target: next };
    setHydrationReadyIdentity(null);
    if (draft) {
      setFieldsRef.current(next);
    }
    setOutcome(null);
    setPhase('idle');
    setAnnounce('');
    variablesRef.current = null;
    submittedFieldsRef.current = null;
    suppressPersistRef.current = false;
    rebaselineAfterSuccessRef.current = false;
    successClosePendingRef.current = false;
    successCloseTokenRef.current = null;
    successCloseCallbackRef.current = undefined;
    if (successCloseFrameRef.current != null) {
      cancelAnimationFrame(successCloseFrameRef.current);
      successCloseFrameRef.current = null;
    }
    closedRef.current = false;
    dismissSeqRef.current.value += 1;
    if (shouldCloseSucceededForm) {
      try {
        closeSucceededForm?.();
      } catch {
        // Identity reset must still complete if the user close hook throws.
      }
    }
  }, [formId, formIdentityKey, persistDraft, profileGeneration, scopeDigest]);

  useLayoutEffect(() => {
    const pending = hydrationTargetRef.current;
    if (!pending || pending.identity !== formIdentityKey) return;
    if (mutationFieldsEqual(fields, pending.target)) {
      setHydrationReadyIdentity(formIdentityKey);
    }
  }, [fields, formIdentityKey]);

  useEffect(() => {
    if (!rebaselineAfterSuccessRef.current) return;
    rebaselineAfterSuccessRef.current = false;
    setBaseline({ ...fieldsRef.current });
    suppressPersistRef.current = false;
  }, [fields]);

  useEffect(() => {
    if (!persistDraft) return;
    if (!shouldPersistMutationFormDraft(
      hydrationReadyIdentity,
      formIdentityKey,
      fields,
      baseline,
      mutationFieldsEqual,
      suppressPersistRef.current || rebaselineAfterSuccessRef.current,
    )) return;
    setMutationFormDraft(scopeDigest, formId, fields, profileGeneration);
  }, [baseline, fields, formId, formIdentityKey, hydrationReadyIdentity, persistDraft, profileGeneration, scopeDigest]);

  const isLocked = dispatchPending
    || phase === 'submitting'
    || phase === 'reconciling'
    || phase === 'success';
  const isDirty = useMemo(
    () => shouldTreatMutationFormAsDirty(
      hydrationReadyIdentity,
      formIdentityKey,
      fields,
      baseline,
      mutationFieldsEqual,
    ),
    [baseline, fields, formIdentityKey, hydrationReadyIdentity],
  );

  useEffect(() => () => {
    if (successCloseFrameRef.current != null) {
      cancelAnimationFrame(successCloseFrameRef.current);
      successCloseFrameRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!shouldScheduleDeferredSuccessClose({
      phase,
      dispatchPending,
      pendingLocked: isPendingLocked(),
      successPending: successClosePendingRef.current,
    })) {
      return;
    }
    const token = successCloseTokenRef.current;
    if (!token || !isDispatchTokenCurrent(token) || closedRef.current) return;

    successCloseFrameRef.current = requestAnimationFrame(() => {
      successCloseFrameRef.current = null;
      const closeToken = successCloseTokenRef.current;
      if (!shouldRunDeferredSuccessClose({
        phase,
        tokenCurrent: closeToken != null && isDispatchTokenCurrent(closeToken),
        pendingLocked: isPendingLocked(),
        dispatchPending,
        alreadyClosed: closedRef.current,
      })) {
        return;
      }
      successClosePendingRef.current = false;
      successCloseTokenRef.current = null;
      const closeSucceededForm = successCloseCallbackRef.current;
      successCloseCallbackRef.current = undefined;
      closedRef.current = true;
      try {
        closeSucceededForm?.();
      } catch {
        // User close hook must not leak lock/draft state.
      } finally {
        setPhase('idle');
      }
    });

    return () => {
      if (successCloseFrameRef.current != null) {
        cancelAnimationFrame(successCloseFrameRef.current);
        successCloseFrameRef.current = null;
      }
    };
  }, [dispatchPending, isDispatchTokenCurrent, isPendingLocked, phase]);

  useEffect(() => {
    if (!shouldInvalidateValidationOutcome(phase, outcome, fields, submittedFieldsRef.current)) return;
    setOutcome(null);
    setPhase('idle');
    setAnnounce('');
    variablesRef.current = null;
    submittedFieldsRef.current = null;
  }, [fields, outcome, phase]);

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

  const handleError = useCallback(async (error: FinanceError, token: MutationDispatchToken) => {
    if (!isDispatchTokenCurrent(token)) return;
    const mapped = mapMutationApiError(error, { fieldPathOverrides, fieldOrder, mutationLabel });
    setOutcome(mapped);
    setPhase('error');
    setAnnounce(mapped.announce);
    if (mapped.requiresRefetch) {
      setPhase('reconciling');
      const ok = await runStaleRefetch(onRefetch);
      if (!isDispatchTokenCurrent(token)) return;
      if (ok && (mapped.kind === 'conflict_stale' || mapped.kind === 'conflict_saga' || mapped.kind === 'conflict_ownership')) {
        setOutcome({ ...mapped, summary: staleConflictNotice(mapped.summary) });
      }
      setPhase('error');
    }
    requestAnimationFrame(() => focusFirstInvalid());
  }, [fieldOrder, fieldPathOverrides, focusFirstInvalid, isDispatchTokenCurrent, mutationLabel, onRefetch]);

  const finalizeDismiss = useCallback((onConfirmed?: () => void, request?: { identity: string; nonce: number }) => {
    if (request && !shouldApplyFormDismiss(request, formIdentityKey, dismissSeqRef.current)) return;
    clearMutationFormDraft(scopeDigest, formId, profileGeneration);
    setOutcome(null);
    setPhase('idle');
    setAnnounce('');
    variablesRef.current = null;
    setBaseline({ ...fieldsRef.current });
    submittedFieldsRef.current = null;
    onConfirmed?.();
  }, [formId, formIdentityKey, profileGeneration, scopeDigest]);

  const runMutation = useCallback((variables: TVariables) => {
    if (pendingLockRef.current) return;
    const lease = acquireAdmission();
    if (lease == null) return;
    const token = captureDispatchToken();
    variablesRef.current = variables;
    submittedFieldsRef.current = { ...fieldsRef.current };
    closedRef.current = false;
    pendingLockRef.current = true;
    bumpActivity();
    setDispatchPending(true);
    setPhase('submitting');
    setOutcome(null);
    let errorReconciliation: Promise<void> | null = null;
    try {
      mutation.mutate(variables, {
        onSuccess: () => {
          if (!isDispatchTokenCurrent(token)) return;
          variablesRef.current = null;
          setPhase('success');
          setAnnounce(`${mutationLabel} succeeded.`);
          suppressPersistRef.current = true;
          clearMutationFormDraft(token.scope, formId, token.generation);
          setBaseline({ ...fieldsRef.current });
          submittedFieldsRef.current = null;
          successCloseTokenRef.current = token;
          successCloseCallbackRef.current = onSuccessCloseRef.current;
          successClosePendingRef.current = true;
        },
        onError: (error) => {
          errorReconciliation = startMutationErrorReconciliation(() => handleError(error, token));
        },
        onSettled: async () => {
          await awaitMutationErrorReconciliation(errorReconciliation);
          releaseAdmissionForLease(lease);
          if (!isDispatchTokenCurrent(token)) return;
          pendingLockRef.current = false;
          setDispatchPending(false);
        },
      });
    } catch (error) {
      releaseAdmissionForLease(lease);
      pendingLockRef.current = false;
      setDispatchPending(false);
      throw error;
    }
  }, [
    acquireAdmission,
    bumpActivity,
    captureDispatchToken,
    formId,
    handleError,
    isDispatchTokenCurrent,
    mutation,
    mutationLabel,
    pendingLockRef,
    releaseAdmissionForLease,
    setDispatchPending,
  ]);

  const submit = useCallback(() => {
    if (pendingLockRef.current || phase === 'submitting' || phase === 'reconciling' || phase === 'success') return;
    if (validate) {
      const clientErrors = validate(fields);
      if (Object.keys(clientErrors).length) {
        bumpActivity();
        submittedFieldsRef.current = captureValidationFieldSnapshot(fields);
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
  }, [buildVariables, bumpActivity, fieldOrder, fields, focusFirstInvalid, phase, pendingLockRef, runMutation, validate]);

  const retry = useCallback(() => {
    if (pendingLockRef.current || phase === 'submitting' || phase === 'reconciling' || phase === 'success') return;
    const submitted = submittedFieldsRef.current;
    if (submitted && !mutationFieldsEqual(fieldsRef.current, submitted)) {
      submit();
      return;
    }
    if (variablesRef.current != null) {
      runMutation(variablesRef.current);
      return;
    }
    submit();
  }, [phase, pendingLockRef, runMutation, submit]);

  const clearErrors = useCallback(() => {
    setOutcome(null);
    setPhase('idle');
    setAnnounce('');
    variablesRef.current = null;
    submittedFieldsRef.current = null;
  }, []);

  const requestDismiss = useCallback((onConfirmed?: () => void) => {
    if (isLocked) return false;
    if (isDirty) {
      const identityAtRequest = formIdentityKey;
      const nonce = nextDismissRequest(dismissSeqRef.current);
      Alert.alert(
        'Discard unsaved changes?',
        'Your edits will be lost.',
        [
          { text: 'Keep editing', style: 'cancel' },
          {
            text: 'Discard',
            style: 'destructive',
            onPress: () => finalizeDismiss(onConfirmed, { identity: identityAtRequest, nonce }),
          },
        ],
      );
      return false;
    }
    finalizeDismiss(onConfirmed);
    return true;
  }, [finalizeDismiss, formIdentityKey, isDirty, isLocked]);

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

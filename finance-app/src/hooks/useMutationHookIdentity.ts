import { useCallback, useEffect, useRef, useState } from 'react';
import {
  bumpMutationHookEpoch,
  captureMutationDispatchToken,
  isMutationDispatchTokenCurrent,
  resetMutationHookPendingLock,
} from '@/lib/mutation-hook-identity';
import { getProfileGeneration } from '@/lib/notification-reconciliation';
import { useServerConfig } from '@/state/server';

export type MutationDispatchToken = ReturnType<typeof captureMutationDispatchToken>;

export interface UseMutationHookIdentityOptions {
  formId?: string;
  pendingLockKind?: 'boolean' | 'counter';
}

export function useMutationHookIdentity(options: UseMutationHookIdentityOptions = {}) {
  const { formId, pendingLockKind = 'boolean' } = options;
  const { scope, demo } = useServerConfig();
  const scopeDigest = demo ? 'demo' : scope;
  const profileGeneration = demo ? 0 : getProfileGeneration();
  const epochRef = useRef({ value: 0 });
  const pendingLockRef = useRef<boolean | number>(pendingLockKind === 'counter' ? 0 : false);
  const [dispatchPending, setDispatchPending] = useState(false);
  const identityKey = `${scopeDigest}:${profileGeneration}:${formId ?? ''}`;

  useEffect(() => {
    bumpMutationHookEpoch(epochRef);
    resetMutationHookPendingLock(pendingLockRef, pendingLockKind);
    // Reset in-flight UI lock when profile/form identity changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional lock reset on identity change
    setDispatchPending(false);
  }, [identityKey, pendingLockKind]);

  useEffect(() => () => {
    bumpMutationHookEpoch(epochRef);
  }, []);

  const captureDispatchToken = useCallback(
    () => captureMutationDispatchToken(epochRef, scopeDigest, profileGeneration, formId),
    [formId, profileGeneration, scopeDigest],
  );

  const isDispatchTokenCurrent = useCallback(
    (token: MutationDispatchToken) => isMutationDispatchTokenCurrent(
      token,
      epochRef,
      scopeDigest,
      profileGeneration,
      formId,
    ),
    [formId, profileGeneration, scopeDigest],
  );

  const resetPendingLock = useCallback(() => {
    resetMutationHookPendingLock(pendingLockRef, pendingLockKind);
    setDispatchPending(false);
  }, [pendingLockKind]);

  return {
    scopeDigest,
    profileGeneration,
    identityKey,
    epochRef,
    pendingLockRef,
    dispatchPending,
    setDispatchPending,
    captureDispatchToken,
    isDispatchTokenCurrent,
    resetPendingLock,
  };
}

import { useEffect, useRef } from 'react';
import { invalidateScreenRetryOnFieldEdit } from '@/lib/mutation-screen-retry-invalidation';

export interface MutationScreenFieldInvalidationTarget {
  outcome: unknown;
  activeKey: string | null;
  clear: () => void;
}

/**
 * Clears stale screen mutation retry state when editable payload drifts after an error.
 */
export function useMutationScreenFieldInvalidation(
  screen: MutationScreenFieldInvalidationTarget,
  actionKey: string,
  currentFields: Record<string, unknown>,
) {
  const snapshotRef = useRef<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!screen.outcome || screen.activeKey !== actionKey) {
      snapshotRef.current = null;
      return;
    }
    snapshotRef.current = { ...currentFields };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot captured once per error activation
  }, [actionKey, screen.activeKey, screen.outcome]);

  useEffect(() => {
    const snapshot = snapshotRef.current;
    if (!snapshot || !screen.outcome || screen.activeKey !== actionKey) return;
    if (invalidateScreenRetryOnFieldEdit(screen, actionKey, snapshot, currentFields)) {
      snapshotRef.current = null;
    }
  }, [actionKey, currentFields, screen, screen.activeKey, screen.outcome]);
}

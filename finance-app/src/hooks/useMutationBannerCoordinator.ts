import { useCallback, useMemo } from 'react';
import type { MappedMutationOutcome } from '@/lib/mutation-form-errors';
import {
  anyMutationSourceLocked,
  pickActiveMutationSource,
  pickMutationAnnounce,
  retryActiveMutationSource,
} from '@/lib/mutation-banner-coordinator';

export interface MutationBannerSource {
  key: string;
  outcome: MappedMutationOutcome | null;
  retry: () => void;
  announce?: string;
  isLocked?: boolean;
}

export interface UseMutationBannerCoordinatorResult {
  outcome: MappedMutationOutcome | null;
  announce: string;
  activeKey: string | null;
  isLocked: boolean;
  retry: () => void;
}

export function useMutationBannerCoordinator(
  sources: MutationBannerSource[],
): UseMutationBannerCoordinatorResult {
  const picked = useMemo(() => pickActiveMutationSource(sources), [sources]);
  const announce = useMemo(() => pickMutationAnnounce(sources), [sources]);
  const isLocked = useMemo(() => anyMutationSourceLocked(sources), [sources]);

  const retry = useCallback(() => {
    const current = pickActiveMutationSource(sources);
    retryActiveMutationSource(sources, current.activeKey);
  }, [sources]);

  return useMemo(() => ({
    outcome: picked.outcome,
    announce,
    activeKey: picked.activeKey,
    isLocked,
    retry,
  }), [announce, isLocked, picked.activeKey, picked.outcome, retry]);
}

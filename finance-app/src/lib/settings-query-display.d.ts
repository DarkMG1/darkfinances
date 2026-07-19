export function resolveReconcileEnabledSetting(
  reconPending: {
    isLoading?: boolean;
    isError?: boolean;
    data?: { enabled?: boolean } | null;
  },
  localOverride: boolean | null,
): {
  initialLoad: boolean;
  fatalError: boolean;
  refetchError: boolean;
  enabled: boolean;
  switchDisabled: boolean;
  misrepresentsWhenFatal: boolean;
};

export const SETTINGS_QUERY_EXCLUSION: {
  file: string;
  reason: string;
};

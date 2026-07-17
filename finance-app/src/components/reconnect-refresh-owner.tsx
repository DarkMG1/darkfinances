import { useEffect, useRef, useSyncExternalStore } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import {
  fetchReconnectSourceFreshness,
  reconcileReconnectOperations,
  refreshReconnectActiveQueries,
  ReconnectRefreshRunToken,
} from '@/lib/reconnect-refresh-actions';
import { isReconnectRefreshActive } from '@/lib/reconnect-refresh-active';
import { subscribeNativeConnectivity } from '@/lib/reconnect-connectivity-native';
import {
  createReconnectRefreshOwner,
  getReconnectStaleWarningStore,
} from '@/lib/reconnect-refresh';
import {
  getProfileGeneration,
  subscribeProfileGeneration,
} from '@/lib/notification-reconciliation';
import {
  registerReconnectForegroundCoincidence,
  registerReconnectRefreshRetry,
} from '@/lib/reconnect-refresh-registry';
import { useServerConfig } from '@/state/server';

function useReconnectRefreshOwner(config: {
  active: boolean;
  scope: string;
  profileGeneration: number;
  serverUrl: string | null;
  token: string | null;
  demo: boolean;
}) {
  const ownerRef = useRef<ReturnType<typeof createReconnectRefreshOwner> | null>(null);
  const configRef = useRef(config);
  configRef.current = config;

  if (!ownerRef.current) {
    ownerRef.current = createReconnectRefreshOwner({
      scope: config.scope,
      profileGeneration: config.profileGeneration,
      initialActive: config.active,
      staleWarning: getReconnectStaleWarningStore(),
      isEnabled: () => isReconnectRefreshActive({
        configured: !!configRef.current.scope,
        demo: configRef.current.demo,
      }),
      fetchSourceFreshness: (token: ReconnectRefreshRunToken) => fetchReconnectSourceFreshness(configRef.current, token),
      reconcileOperations: (token: ReconnectRefreshRunToken) => reconcileReconnectOperations(configRef.current, token),
      refreshActiveQueries: (token: ReconnectRefreshRunToken) => refreshReconnectActiveQueries(configRef.current, token),
    });
  }

  const owner = ownerRef.current;

  useEffect(() => {
    owner.setScope(config.scope);
    owner.setProfileGeneration(config.profileGeneration);
    owner.setActive(config.active);
  }, [config.active, config.demo, config.profileGeneration, config.scope, owner]);

  useEffect(() => {
    if (!config.active) return undefined;
    return subscribeNativeConnectivity((snapshot) => {
      owner.handleConnectivitySnapshot(snapshot);
    });
  }, [config.active, owner]);

  useEffect(() => {
    const updateAppState = (next: AppStateStatus) => {
      if (next === 'active') owner.noteForegroundCoincidence();
    };
    updateAppState(AppState.currentState);
    const sub = AppState.addEventListener('change', updateAppState);
    return () => sub.remove();
  }, [owner]);

  useEffect(() => {
    const unregisterRetry = registerReconnectRefreshRetry(() => owner.startRefresh('manual'));
    const unregisterForeground = registerReconnectForegroundCoincidence(() => owner.noteForegroundCoincidence());
    return () => {
      unregisterRetry();
      unregisterForeground();
    };
  }, [owner]);

  useEffect(() => () => owner.dispose(), [owner]);

  return owner;
}

export function ReconnectRefreshOwner() {
  const { configured, demo, scope, serverUrl, token } = useServerConfig();
  const refreshActive = isReconnectRefreshActive({ configured, demo });
  const profileGeneration = useSyncExternalStore(
    subscribeProfileGeneration,
    getProfileGeneration,
    getProfileGeneration,
  );

  useReconnectRefreshOwner({
    active: refreshActive,
    scope,
    profileGeneration,
    serverUrl,
    token,
    demo,
  });

  return null;
}

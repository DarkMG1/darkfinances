import { useEffect, useSyncExternalStore } from 'react';
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
  configureReconnectRefreshOwnerDeps,
  getSharedReconnectRefreshOwner,
  updateReconnectRefreshRuntimeConfig,
} from '@/lib/reconnect-refresh-owner-runtime';
import {
  getProfileGeneration,
  subscribeProfileGeneration,
} from '@/lib/notification-reconciliation';
import {
  registerReconnectConnectivityPhase,
  registerReconnectForegroundCoincidence,
  registerReconnectRefreshRetry,
  registerReconnectServerRecovery,
} from '@/lib/reconnect-refresh-registry';
import { useServerConfig } from '@/state/server';

const serverConfigRef: {
  scope: string;
  serverUrl: string | null;
  token: string | null;
  demo: boolean;
} = {
  scope: '',
  serverUrl: null,
  token: null,
  demo: false,
};

let ownerConfigured = false;

function ensureSharedOwnerConfigured() {
  if (ownerConfigured) return;
  configureReconnectRefreshOwnerDeps({
    fetchSourceFreshness: (token: ReconnectRefreshRunToken) =>
      fetchReconnectSourceFreshness(serverConfigRef, token),
    reconcileOperations: (token: ReconnectRefreshRunToken) =>
      reconcileReconnectOperations(serverConfigRef, token),
    refreshActiveQueries: (token: ReconnectRefreshRunToken) =>
      refreshReconnectActiveQueries(serverConfigRef, token),
  });
  ownerConfigured = true;
}

export function ReconnectRefreshOwner() {
  const { configured, demo, scope, serverUrl, token } = useServerConfig();
  const refreshActive = isReconnectRefreshActive({ configured, demo });
  const profileGeneration = useSyncExternalStore(
    subscribeProfileGeneration,
    getProfileGeneration,
    getProfileGeneration,
  );

  useEffect(() => {
    ensureSharedOwnerConfigured();
    serverConfigRef.scope = scope;
    serverConfigRef.serverUrl = serverUrl;
    serverConfigRef.token = token;
    serverConfigRef.demo = demo;
    updateReconnectRefreshRuntimeConfig({
      scope,
      profileGeneration,
      active: refreshActive,
      demo,
    });
  }, [demo, profileGeneration, refreshActive, scope, serverUrl, token]);

  useEffect(() => {
    if (!refreshActive) return undefined;
    const owner = getSharedReconnectRefreshOwner();
    return subscribeNativeConnectivity((snapshot) => {
      owner.handleConnectivitySnapshot(snapshot);
    });
  }, [refreshActive]);

  useEffect(() => {
    const owner = getSharedReconnectRefreshOwner();
    const updateAppState = (next: AppStateStatus) => {
      if (next === 'active') owner.noteForegroundCoincidence();
    };
    updateAppState(AppState.currentState);
    const sub = AppState.addEventListener('change', updateAppState);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    const owner = getSharedReconnectRefreshOwner();
    const unregisterRetry = registerReconnectRefreshRetry(() => owner.startRefresh('manual'));
    const unregisterForeground = registerReconnectForegroundCoincidence(() => owner.noteForegroundCoincidence());
    const unregisterRecovery = registerReconnectServerRecovery(() => owner.startRefresh('server-recovery'));
    const unregisterConnectivity = registerReconnectConnectivityPhase(() => owner.connectivity.getPhase());
    return () => {
      unregisterRetry();
      unregisterForeground();
      unregisterRecovery();
      unregisterConnectivity();
    };
  }, []);

  return null;
}

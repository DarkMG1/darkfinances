import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { normalizeServerUrl } from '@/api/client/server-url';
import { financeOperationProfileScope } from '@/lib/finance-operations';
import {
  activateNotificationScope,
  getProfileGeneration,
  hasPersistedSuspensionEvidence,
} from '@/lib/notification-reconciliation';
import { purgeFinanceProfile } from '@/lib/profile-purge';
import { financeServerScope } from '@/lib/query-client';
import {
  rollbackPersistedServerIdentity,
  shouldReactivateOldScopeAfterSetConfigFailure,
} from '@/lib/server-config-set';
import { kv } from '@/lib/storage';

const TOKEN_KEY = 'finance_token';
const URL_KEY = 'finance_url';
const FACEID_KEY = 'finance_faceid';
const DEMO_KEY = 'finance_demo';
const LEGACY_QUERY_CACHE_KEY = 'rq-cache-v2';

export interface ServerConfig {
  serverUrl: string | null;
  token: string | null;
  faceId: boolean;
  demo: boolean;
  scope: string;
  configured: boolean;
  ready: boolean;
}

interface ServerContextValue extends ServerConfig {
  setConfig: (next: { serverUrl?: string | null; token?: string | null; faceId?: boolean; demo?: boolean }) => Promise<void>;
  clear: () => Promise<void>;
}

const ServerContext = createContext<ServerContextValue | null>(null);

export function ServerProvider({ children }: { children: React.ReactNode }) {
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [faceId, setFaceId] = useState<boolean>(false);
  const [demo, setDemo] = useState<boolean>(false);
  const [ready, setReady] = useState<boolean>(false);

  useEffect(() => {
    (async () => {
      kv.setString(LEGACY_QUERY_CACHE_KEY, null);
      const rawStoredUrl = kv.getString(URL_KEY);
      let storedUrl: string | null = null;
      if (rawStoredUrl) {
        try {
          storedUrl = normalizeServerUrl(rawStoredUrl);
          kv.setString(URL_KEY, storedUrl);
        } catch {
          kv.setString(URL_KEY, null);
        }
      }
      const storedDemo = kv.getBool(DEMO_KEY, false);
      let storedToken: string | null = null;
      setServerUrl(storedUrl);
      setFaceId(kv.getBool(FACEID_KEY, false));
      setDemo(storedDemo);
      try {
        storedToken = await SecureStore.getItemAsync(TOKEN_KEY);
        if (storedToken) {
          await SecureStore.setItemAsync(TOKEN_KEY, storedToken, {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
          });
        }
      } catch {
        storedToken = null;
      }
      setToken(storedToken);
      setReady(true);
    })();
  }, []);

  const setConfig = useCallback(
    async (next: { serverUrl?: string | null; token?: string | null; faceId?: boolean; demo?: boolean }) => {
      const nextUrl = next.serverUrl === undefined
        ? serverUrl
        : next.serverUrl
          ? normalizeServerUrl(next.serverUrl)
          : null;
      const nextToken = next.token === undefined ? token : next.token;
      const nextFaceId = next.faceId === undefined ? faceId : next.faceId;
      const nextDemo = next.demo === undefined ? demo : next.demo;
      const identityChanged = nextUrl !== serverUrl || nextToken !== token || nextDemo !== demo;
      const oldScope = financeServerScope(serverUrl, token, demo);
      const oldOperationScope = financeOperationProfileScope(serverUrl, token, demo);
      let tokenWriteMayHaveOccurred = false;
      let reactCommitted = false;

      try {
        if (identityChanged) {
          await purgeFinanceProfile(oldScope, oldOperationScope);
        }
        if (next.token !== undefined) {
          tokenWriteMayHaveOccurred = true;
          if (nextToken) {
            await SecureStore.setItemAsync(TOKEN_KEY, nextToken, {
              keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
            });
          } else {
            await SecureStore.deleteItemAsync(TOKEN_KEY);
          }
        }
        kv.setString(URL_KEY, nextUrl);
        kv.setBool(FACEID_KEY, nextFaceId);
        kv.setBool(DEMO_KEY, nextDemo);
        setServerUrl(nextUrl);
        setToken(nextToken);
        setFaceId(nextFaceId);
        setDemo(nextDemo);
        reactCommitted = true;
        activateNotificationScope(
          financeServerScope(nextUrl, nextToken, nextDemo),
          getProfileGeneration(),
        );
      } catch (error) {
        // Keep the persisted identity tuple coherent if any storage write fails.
        // Query clearing is intentionally not rolled back; stale financial data
        // is safer to discard than to restore under an uncertain identity.
        const rollbackOk = await rollbackPersistedServerIdentity({
          kv,
          secureStore: SecureStore,
          keys: {
            url: URL_KEY,
            faceId: FACEID_KEY,
            demo: DEMO_KEY,
            token: TOKEN_KEY,
          },
          previous: {
            serverUrl,
            token,
            faceId,
            demo,
          },
          tokenWriteMayHaveOccurred,
          secureStoreOptions: {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
          },
        }).catch(() => false);
        if (shouldReactivateOldScopeAfterSetConfigFailure({
          identityChanged,
          rollbackOk,
          reactCommitted,
          oldScope,
          hasPersistedSuspension: hasPersistedSuspensionEvidence,
        })) {
          activateNotificationScope(oldScope, getProfileGeneration());
        }
        throw error;
      }
    },
    [demo, faceId, serverUrl, token]
  );

  const clear = useCallback(async () => {
    const oldScope = financeServerScope(serverUrl, token, demo);
    const oldOperationScope = financeOperationProfileScope(serverUrl, token, demo);
    await purgeFinanceProfile(oldScope, oldOperationScope);
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    kv.setString(URL_KEY, null);
    kv.setString(LEGACY_QUERY_CACHE_KEY, null);
    kv.setBool(FACEID_KEY, false);
    kv.setBool(DEMO_KEY, false);
    setServerUrl(null);
    setToken(null);
    setFaceId(false);
    setDemo(false);
  }, [demo, serverUrl, token]);

  const value = useMemo<ServerContextValue>(
    () => ({
      serverUrl,
      token,
      faceId,
      demo,
      scope: financeServerScope(serverUrl, token, demo),
      configured: !!serverUrl && !!token,
      ready,
      setConfig,
      clear,
    }),
    [serverUrl, token, faceId, demo, ready, setConfig, clear]
  );

  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export function useServerConfig(): ServerContextValue {
  const ctx = useContext(ServerContext);
  if (!ctx) throw new Error('useServerConfig must be used within ServerProvider');
  return ctx;
}

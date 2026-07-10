import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { normalizeServerUrl } from '@/api/client/server-url';
import { clearFinanceNotifications } from '@/lib/notifications';
import { clearFinanceQueries, financeServerScope } from '@/lib/query-client';
import { abortFinanceRequests } from '@/lib/request-lifecycle';
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
      const storedUrl = kv.getString(URL_KEY);
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

      try {
        if (next.token !== undefined) {
          if (nextToken) {
            await SecureStore.setItemAsync(TOKEN_KEY, nextToken, {
              keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
            });
          } else {
            await SecureStore.deleteItemAsync(TOKEN_KEY);
          }
        }
        if (identityChanged) {
          abortFinanceRequests();
          await clearFinanceQueries();
        }
        kv.setString(URL_KEY, nextUrl);
        kv.setBool(FACEID_KEY, nextFaceId);
        kv.setBool(DEMO_KEY, nextDemo);
        setServerUrl(nextUrl);
        setToken(nextToken);
        setFaceId(nextFaceId);
        setDemo(nextDemo);
      } catch (error) {
        if (next.token !== undefined) {
          try {
            if (token) {
              await SecureStore.setItemAsync(TOKEN_KEY, token, {
                keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
              });
            } else {
              await SecureStore.deleteItemAsync(TOKEN_KEY);
            }
          } catch {}
        }
        throw error;
      }
    },
    [demo, faceId, serverUrl, token]
  );

  const clear = useCallback(async () => {
    abortFinanceRequests();
    await clearFinanceQueries();
    await clearFinanceNotifications(financeServerScope(serverUrl, token, demo)).catch(() => {});
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

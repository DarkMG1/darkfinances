import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { kv } from '@/lib/storage';

const TOKEN_KEY = 'finance_token';
const URL_KEY = 'finance_url';
const FACEID_KEY = 'finance_faceid';
const DEMO_KEY = 'finance_demo';

export interface ServerConfig {
  serverUrl: string | null;
  token: string | null;
  faceId: boolean;
  demo: boolean;
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
      setServerUrl(kv.getString(URL_KEY));
      setFaceId(kv.getBool(FACEID_KEY, false));
      setDemo(kv.getBool(DEMO_KEY, false));
      try {
        setToken(await SecureStore.getItemAsync(TOKEN_KEY));
      } catch {
        setToken(null);
      }
      setReady(true);
    })();
  }, []);

  const setConfig = useCallback(
    async (next: { serverUrl?: string | null; token?: string | null; faceId?: boolean; demo?: boolean }) => {
      if (next.serverUrl !== undefined) {
        kv.setString(URL_KEY, next.serverUrl);
        setServerUrl(next.serverUrl);
      }
      if (next.faceId !== undefined) {
        kv.setBool(FACEID_KEY, next.faceId);
        setFaceId(next.faceId);
      }
      if (next.demo !== undefined) {
        kv.setBool(DEMO_KEY, next.demo);
        setDemo(next.demo);
      }
      if (next.token !== undefined) {
        if (next.token) await SecureStore.setItemAsync(TOKEN_KEY, next.token);
        else await SecureStore.deleteItemAsync(TOKEN_KEY);
        setToken(next.token);
      }
    },
    []
  );

  const clear = useCallback(async () => {
    kv.setString(URL_KEY, null);
    kv.setBool(FACEID_KEY, false);
    kv.setBool(DEMO_KEY, false);
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    setServerUrl(null);
    setToken(null);
    setFaceId(false);
    setDemo(false);
  }, []);

  const value = useMemo<ServerContextValue>(
    () => ({
      serverUrl,
      token,
      faceId,
      demo,
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

export interface ServerIdentityTuple {
  serverUrl: string | null;
  token: string | null;
  faceId: boolean;
  demo: boolean;
}

export interface RollbackPersistedServerIdentityInput {
  kv: {
    getString: (key: string) => string | null;
    setString: (key: string, value: string | null) => void;
    getBool: (key: string, fallback?: boolean) => boolean;
    setBool: (key: string, value: boolean) => void;
  };
  secureStore: {
    setItemAsync: (key: string, value: string, options?: Record<string, unknown>) => Promise<void>;
    deleteItemAsync: (key: string) => Promise<void>;
    getItemAsync: (key: string) => Promise<string | null>;
  };
  keys: { url: string; faceId: string; demo: string; token: string };
  previous: ServerIdentityTuple;
  tokenWriteMayHaveOccurred: boolean;
  secureStoreOptions?: Record<string, unknown>;
}

export function rollbackPersistedServerIdentity(input: RollbackPersistedServerIdentityInput): Promise<boolean>;

export function shouldReactivateOldScopeAfterSetConfigFailure(input: {
  identityChanged: boolean;
  rollbackOk: boolean;
  reactCommitted: boolean;
  oldScope: string | undefined;
  hasPersistedSuspension: (scope: string | undefined) => boolean;
}): boolean;

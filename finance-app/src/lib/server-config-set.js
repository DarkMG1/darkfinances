'use strict';

/**
 * @param {{
 *   kv: {
 *     getString: (key: string) => string | null;
 *     setString: (key: string, value: string | null) => void;
 *     getBool: (key: string, fallback?: boolean) => boolean;
 *     setBool: (key: string, value: boolean) => void;
 *   };
 *   secureStore: {
 *     setItemAsync: (key: string, value: string, options?: Record<string, unknown>) => Promise<void>;
 *     deleteItemAsync: (key: string) => Promise<void>;
 *     getItemAsync: (key: string) => Promise<string | null>;
 *   };
 *   keys: { url: string; faceId: string; demo: string; token: string };
 *   previous: { serverUrl: string | null; token: string | null; faceId: boolean; demo: boolean };
 *   tokenWriteMayHaveOccurred: boolean;
 *   secureStoreOptions?: Record<string, unknown>;
 * }} input
 */
async function rollbackPersistedServerIdentity(input) {
  const {
    kv,
    secureStore,
    keys,
    previous,
    tokenWriteMayHaveOccurred,
    secureStoreOptions = {},
  } = input;

  let kvRollbackOk = false;
  let tokenRollbackOk = !tokenWriteMayHaveOccurred;

  try {
    kv.setString(keys.url, previous.serverUrl);
    kv.setBool(keys.faceId, previous.faceId);
    kv.setBool(keys.demo, previous.demo);
    kvRollbackOk = (
      kv.getString(keys.url) === previous.serverUrl
      && kv.getBool(keys.faceId, false) === previous.faceId
      && kv.getBool(keys.demo, false) === previous.demo
    );
  } catch {
    kvRollbackOk = false;
  }

  if (tokenWriteMayHaveOccurred) {
    try {
      if (previous.token) {
        await secureStore.setItemAsync(keys.token, previous.token, secureStoreOptions);
      } else {
        await secureStore.deleteItemAsync(keys.token);
      }
      const storedToken = await secureStore.getItemAsync(keys.token);
      tokenRollbackOk = storedToken === (previous.token ?? null);
    } catch {
      tokenRollbackOk = false;
    }
  }

  return kvRollbackOk && tokenRollbackOk;
}

/**
 * @param {{
 *   identityChanged: boolean;
 *   rollbackOk: boolean;
 *   reactCommitted: boolean;
 *   oldScope: string | undefined;
 *   hasPersistedSuspension: (scope: string | undefined) => boolean;
 * }} input
 */
function shouldReactivateOldScopeAfterSetConfigFailure(input) {
  const {
    identityChanged,
    rollbackOk,
    reactCommitted,
    oldScope,
    hasPersistedSuspension,
  } = input;
  if (!identityChanged || !rollbackOk || reactCommitted || !oldScope) {
    return false;
  }
  return hasPersistedSuspension(oldScope);
}

module.exports = {
  rollbackPersistedServerIdentity,
  shouldReactivateOldScopeAfterSetConfigFailure,
};

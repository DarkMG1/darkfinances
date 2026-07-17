const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  activateNotificationScope,
  beginReconciliation,
  bindNotificationScopeSuspensionPersistence,
  getProfileGeneration,
  isNotificationScopeSuspended,
  purgeProfileGeneration,
  resetNotificationReconciliationState,
  simulateNotificationScopeSuspensionModuleReset,
} = require('../src/lib/notification-reconciliation');
const {
  rollbackPersistedServerIdentity,
  shouldReactivateOldScopeAfterSetConfigFailure,
} = require('../src/lib/server-config-set');
const { hasPersistedSuspensionEvidence } = require('../src/lib/notification-scope-suspension');

const URL_KEY = 'finance_url';
const FACEID_KEY = 'finance_faceid';
const DEMO_KEY = 'finance_demo';
const TOKEN_KEY = 'finance_token';

function financeServerScope(serverUrl, token, demo) {
  const input = `${serverUrl ?? ''}\u0000${token ?? ''}\u0000${demo ? 'demo' : 'live'}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `server-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function createIdentityStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    kv: {
      getString: (key) => (values.has(key) ? values.get(key) : null),
      setString: (key, value) => {
        if (value == null) values.delete(key);
        else values.set(key, value);
      },
      getBool: (key, fallback = false) => {
        if (!values.has(key)) return fallback;
        return values.get(key) === 'true';
      },
      setBool: (key, value) => values.set(key, value ? 'true' : 'false'),
    },
    values,
  };
}

function createSecureStore(initial = {}) {
  const tokens = new Map(Object.entries(initial));
  let failNextWrite = false;
  let failNextRead = false;
  let failRollbackWrite = false;
  return {
    tokens,
    failNextWrite(value) {
      failNextWrite = value;
    },
    failNextRead(value) {
      failNextRead = value;
    },
    failRollbackWrite(value) {
      failRollbackWrite = value;
    },
    async setItemAsync(key, value) {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error('secure store write failed');
      }
      if (failRollbackWrite && value === 'old-token') {
        failRollbackWrite = false;
        throw new Error('secure store rollback write failed');
      }
      tokens.set(key, value);
    },
    async deleteItemAsync(key) {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error('secure store delete failed');
      }
      tokens.delete(key);
    },
    async getItemAsync(key) {
      if (failNextRead) {
        failNextRead = false;
        throw new Error('secure store read failed');
      }
      return tokens.has(key) ? tokens.get(key) : null;
    },
  };
}

function createSuspensionStore() {
  const values = new Map();
  return {
    kv: {
      getString: (key) => (values.has(key) ? values.get(key) : null),
      setString: (key, value) => {
        if (value == null) values.delete(key);
        else values.set(key, value);
      },
    },
    storage: {
      getAllKeys: () => [...values.keys()],
      remove: (key) => values.delete(key),
    },
    values,
  };
}

function previousIdentity() {
  return {
    serverUrl: 'https://old.example',
    token: 'old-token',
    faceId: true,
    demo: false,
  };
}

async function simulateSetConfigFailure(input) {
  const {
    store,
    secureStore,
    previous,
    next,
    identityChanged,
    failAfterPurge,
  } = input;
  const oldScope = financeServerScope(previous.serverUrl, previous.token, previous.demo);
  let purgeCompleted = false;
  let reactCommitted = false;

  try {
    if (identityChanged) {
      purgeProfileGeneration(oldScope);
      purgeCompleted = true;
    }
    if (next.token !== undefined) {
      if (next.token) {
        await secureStore.setItemAsync(TOKEN_KEY, next.token);
      } else {
        await secureStore.deleteItemAsync(TOKEN_KEY);
      }
    }
    await failAfterPurge(store);
    store.kv.setString(URL_KEY, next.serverUrl ?? null);
    store.kv.setBool(FACEID_KEY, next.faceId ?? previous.faceId);
    store.kv.setBool(DEMO_KEY, next.demo ?? previous.demo);
    reactCommitted = true;
    activateNotificationScope(
      financeServerScope(next.serverUrl ?? null, next.token ?? previous.token, next.demo ?? previous.demo),
      getProfileGeneration(),
    );
  } catch (error) {
    const rollbackOk = await rollbackPersistedServerIdentity({
      kv: store.kv,
      secureStore,
      keys: { url: URL_KEY, faceId: FACEID_KEY, demo: DEMO_KEY, token: TOKEN_KEY },
      previous,
      tokenTouched: next.token !== undefined,
    }).catch(() => false);
    if (shouldReactivateOldScopeAfterSetConfigFailure({
      identityChanged,
      purgeCompleted,
      rollbackOk,
      reactCommitted,
      oldScope,
      hasPersistedSuspension: hasPersistedSuspensionEvidence,
    })) {
      activateNotificationScope(oldScope, getProfileGeneration());
    }
    throw error;
  }
}

test.beforeEach(() => {
  resetNotificationReconciliationState();
  bindNotificationScopeSuspensionPersistence(createSuspensionStore());
});

test('rollbackPersistedServerIdentity verifies restored KV and token tuple', async () => {
  const store = createIdentityStore({
    [URL_KEY]: 'https://old.example',
    [FACEID_KEY]: 'true',
    [DEMO_KEY]: 'false',
  });
  const secureStore = createSecureStore({ [TOKEN_KEY]: 'old-token' });

  store.kv.setString(URL_KEY, 'https://broken.example');
  store.kv.setBool(FACEID_KEY, false);
  await secureStore.setItemAsync(TOKEN_KEY, 'broken-token');

  const ok = await rollbackPersistedServerIdentity({
    kv: store.kv,
    secureStore,
    keys: { url: URL_KEY, faceId: FACEID_KEY, demo: DEMO_KEY, token: TOKEN_KEY },
    previous: previousIdentity(),
    tokenTouched: true,
  });

  assert.equal(ok, true);
  assert.equal(store.kv.getString(URL_KEY), 'https://old.example');
  assert.equal(await secureStore.getItemAsync(TOKEN_KEY), 'old-token');
});

test('rollbackPersistedServerIdentity returns false when token rollback fails', async () => {
  const store = createIdentityStore({
    [URL_KEY]: 'https://old.example',
    [FACEID_KEY]: 'true',
    [DEMO_KEY]: 'false',
  });
  const secureStore = createSecureStore({ [TOKEN_KEY]: 'new-token' });
  secureStore.failNextWrite(true);

  const ok = await rollbackPersistedServerIdentity({
    kv: store.kv,
    secureStore,
    keys: { url: URL_KEY, faceId: FACEID_KEY, demo: DEMO_KEY, token: TOKEN_KEY },
    previous: previousIdentity(),
    tokenTouched: true,
  });

  assert.equal(ok, false);
});

test('shouldReactivateOldScopeAfterSetConfigFailure requires durable purge tombstone', () => {
  const oldScope = financeServerScope('https://old.example', 'old-token', false);
  assert.equal(shouldReactivateOldScopeAfterSetConfigFailure({
    identityChanged: true,
    purgeCompleted: true,
    rollbackOk: true,
    reactCommitted: false,
    oldScope,
    hasPersistedSuspension: () => false,
  }), false);
  assert.equal(shouldReactivateOldScopeAfterSetConfigFailure({
    identityChanged: true,
    purgeCompleted: false,
    rollbackOk: true,
    reactCommitted: false,
    oldScope,
    hasPersistedSuspension: () => true,
  }), false);
});

test('setConfig failure with full rollback reactivates old scope after successful purge', async () => {
  const store = createIdentityStore({
    [URL_KEY]: 'https://old.example',
    [FACEID_KEY]: 'true',
    [DEMO_KEY]: 'false',
  });
  const secureStore = createSecureStore({ [TOKEN_KEY]: 'old-token' });
  const previous = previousIdentity();
  const oldScope = financeServerScope(previous.serverUrl, previous.token, previous.demo);
  const configError = new Error('kv write failed');

  await assert.rejects(
    () => simulateSetConfigFailure({
      store,
      secureStore,
      previous,
      next: {
        serverUrl: 'https://new.example',
        token: 'new-token',
        faceId: false,
        demo: false,
      },
      identityChanged: true,
      failAfterPurge: async () => {
        throw configError;
      },
    }),
    (error) => error === configError,
  );

  assert.equal(isNotificationScopeSuspended(oldScope), false);
  beginReconciliation('scheduled', getProfileGeneration(), oldScope);
  assert.equal(store.kv.getString(URL_KEY), previous.serverUrl);
  assert.equal(await secureStore.getItemAsync(TOKEN_KEY), previous.token);
});

test('setConfig failure keeps old scope suspended when token rollback fails', async () => {
  const store = createIdentityStore({
    [URL_KEY]: 'https://old.example',
    [FACEID_KEY]: 'true',
    [DEMO_KEY]: 'false',
  });
  const secureStore = createSecureStore({ [TOKEN_KEY]: 'old-token' });
  const previous = previousIdentity();
  const oldScope = financeServerScope(previous.serverUrl, previous.token, previous.demo);
  secureStore.failRollbackWrite(true);

  await assert.rejects(
    () => simulateSetConfigFailure({
      store,
      secureStore,
      previous,
      next: { token: 'new-token' },
      identityChanged: true,
      failAfterPurge: async () => {
        throw new Error('kv write failed');
      },
    }),
    (error) => error.message === 'kv write failed',
  );

  assert.equal(isNotificationScopeSuspended(oldScope), true);
  assert.throws(
    () => beginReconciliation('scheduled', getProfileGeneration(), oldScope),
    (error) => error.code === 'NOTIFICATION_RECONCILIATION_STALE',
  );
});

test('setConfig rollback reactivates only the old scope and leaves unrelated tombstones', async () => {
  const store = createIdentityStore({
    [URL_KEY]: 'https://old.example',
    [FACEID_KEY]: 'true',
    [DEMO_KEY]: 'false',
  });
  const secureStore = createSecureStore({ [TOKEN_KEY]: 'old-token' });
  const previous = previousIdentity();
  const oldScope = financeServerScope(previous.serverUrl, previous.token, previous.demo);
  const unrelatedScope = financeServerScope('https://other.example', 'other-token', false);
  purgeProfileGeneration(unrelatedScope);
  simulateNotificationScopeSuspensionModuleReset();

  await assert.rejects(
    () => simulateSetConfigFailure({
      store,
      secureStore,
      previous,
      next: { serverUrl: 'https://new.example', token: 'new-token' },
      identityChanged: true,
      failAfterPurge: async () => {
        throw new Error('kv write failed');
      },
    }),
    (error) => error.message === 'kv write failed',
  );

  assert.equal(isNotificationScopeSuspended(oldScope), false);
  assert.equal(isNotificationScopeSuspended(unrelatedScope), true);
});

test('server setConfig source reactivates old scope only after verified rollback', () => {
  const serverSource = fs.readFileSync(
    path.join(__dirname, '../src/state/server.tsx'),
    'utf8',
  );
  assert.match(serverSource, /rollbackPersistedServerIdentity\(/);
  assert.match(serverSource, /shouldReactivateOldScopeAfterSetConfigFailure\(/);
  assert.match(serverSource, /activateNotificationScope\(oldScope,\s*getProfileGeneration\(\)\)/);
  assert.match(serverSource, /hasPersistedSuspensionEvidence/);
  assert.doesNotMatch(serverSource, /activateNotificationScope\([\s\S]*financeServerScope\(storedUrl/);
});

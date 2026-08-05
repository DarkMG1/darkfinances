const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const serverPath = path.join(__dirname, '../src/state/server.tsx');

function loadServerModule(secureStore) {
  const source = fs.readFileSync(serverPath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: serverPath,
  });
  const module = { exports: {} };
  const stubs = {
    'expo-secure-store': secureStore,
    '@/api/client/server-url': { normalizeServerUrl: (value) => value },
    '@/lib/finance-operations': { financeOperationProfileScope: () => 'operation-scope' },
    '@/lib/notification-reconciliation': {
      activateNotificationScope: () => {},
      getProfileGeneration: () => 0,
      hasPersistedSuspensionEvidence: () => false,
    },
    '@/lib/profile-purge': { purgeFinanceProfile: async () => {} },
    '@/lib/query-client': { financeServerScope: () => 'server-scope' },
    '@/lib/server-config-set': {
      rollbackPersistedServerIdentity: async () => true,
      shouldReactivateOldScopeAfterSetConfigFailure: () => false,
    },
    '@/lib/storage': { kv: {} },
  };

  vm.runInNewContext(outputText, {
    module,
    exports: module.exports,
    require: (specifier) => (
      Object.hasOwn(stubs, specifier) ? stubs[specifier] : require(specifier)
    ),
  }, { filename: serverPath });

  return module.exports;
}

test('boot keeps a fetched token when the accessibility rewrite fails', async () => {
  const calls = [];
  const secureStore = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    async getItemAsync(key) {
      calls.push({ operation: 'get', key });
      return 'persisted-token';
    },
    async setItemAsync(key, value, options) {
      calls.push({ operation: 'set', key, value, options });
      throw new Error('Keychain rewrite failed');
    },
  };
  const { loadStoredToken } = loadServerModule(secureStore);

  assert.equal(await loadStoredToken(), 'persisted-token');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].operation, 'get');
  assert.equal(calls[0].key, 'finance_token');
  assert.equal(calls[1].operation, 'set');
  assert.equal(calls[1].key, 'finance_token');
  assert.equal(calls[1].value, 'persisted-token');
  assert.equal(calls[1].options.keychainAccessible, 6);
});

test('boot still returns null when the token read itself fails', async () => {
  let writes = 0;
  const secureStore = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    async getItemAsync() {
      throw new Error('Keychain read failed');
    },
    async setItemAsync() {
      writes += 1;
    },
  };
  const { loadStoredToken } = loadServerModule(secureStore);

  assert.equal(await loadStoredToken(), null);
  assert.equal(writes, 0);
});

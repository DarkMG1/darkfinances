'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const toolsRoot = path.resolve(__dirname, '..');

function installMockActual(root) {
  const apiDir = path.join(root, 'node_modules', '@actual-app', 'api');
  fs.mkdirSync(apiDir, { recursive: true });
  fs.writeFileSync(
    path.join(apiDir, 'package.json'),
    JSON.stringify({ name: '@actual-app/api', main: 'index.js' }),
  );
  fs.writeFileSync(path.join(apiDir, 'index.js'), `
'use strict';
const fs = require('node:fs');
let updateCalls = 0;

function record(name, details = {}) {
  fs.appendFileSync(
    process.env.MOCK_CALLS_PATH,
    JSON.stringify({ name, ...details }) + '\\n',
  );
}

const query = {};
for (const method of ['filter', 'select', 'options', 'limit']) {
  query[method] = () => query;
}

module.exports = {
  init: async () => record('init'),
  downloadBudget: async () => record('downloadBudget'),
  getCategoryGroups: async () => [{
    name: 'Expenses',
    categories: [{ id: 'reimbursement', name: 'Reimbursement' }],
  }],
  getPayees: async () => [
    { id: 'payee-1', name: 'Alex payment' },
    { id: 'payee-2', name: 'Second merchant' },
  ],
  getAccounts: async () => [{ id: 'account-1', closed: false, offbudget: false }],
  getTransactions: async () => [
    { id: 'transaction-1', date: '2026-07-01', amount: 1000, payee: 'payee-1', notes: '' },
    { id: 'transaction-2', date: '2026-07-02', amount: 1000, payee: 'payee-1', notes: '' },
  ],
  updateTransaction: async (id, patch) => {
    updateCalls++;
    record('updateTransaction', { id, patch });
    if (process.env.MOCK_FAIL === 'second-update' && updateCalls === 2) {
      throw new Error('mock-second-update-failure');
    }
  },
  getRules: async () => [],
  q: () => query,
  runQuery: async () => ({
    data: [
      { payee: 'payee-1', category: 'reimbursement' },
      { payee: 'payee-1', category: 'reimbursement' },
      { payee: 'payee-2', category: 'reimbursement' },
      { payee: 'payee-2', category: 'reimbursement' },
    ],
  }),
  createRule: async (rule) => record('createRule', { payee: rule.conditions[0].value }),
  sync: async () => {
    record('sync');
    if (process.env.MOCK_FAIL === 'sync') throw new Error('mock-sync-failure');
  },
  shutdown: async () => record('shutdown'),
};
`);
}

function readCalls(callsPath) {
  if (!fs.existsSync(callsPath)) return [];
  const text = fs.readFileSync(callsPath, 'utf8').trim();
  return text ? text.split('\n').map((line) => JSON.parse(line)) : [];
}

function runMutationTool(t, scriptName, { fail = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-tools-mutation-sync-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(toolsRoot, scriptName), path.join(dir, scriptName));
  fs.cpSync(path.join(toolsRoot, 'lib'), path.join(dir, 'lib'), { recursive: true });
  installMockActual(dir);

  const env = {
    ...process.env,
    CONFIRM: '1',
    FIX_DATA_DIR: path.join(dir, 'actual-data'),
    MOCK_CALLS_PATH: path.join(dir, 'calls.jsonl'),
    MOCK_FAIL: fail,
    NODE_PATH: [
      path.join(toolsRoot, 'node_modules'),
      path.join(toolsRoot, '..', 'node_modules'),
    ].join(path.delimiter),
  };

  if (scriptName === 'event-collect.js') {
    const configPath = path.join(dir, 'collection-rules.json');
    fs.writeFileSync(configPath, JSON.stringify({
      events: {
        trip: {
          group: '123',
          tag: 'ev-trip',
          start: '2026-01-01',
          debtors: { alex: { patterns: ['\\balex\\b'] } },
        },
      },
    }));
    fs.writeFileSync(path.join(dir, 'splitwise-lib.js'), `
module.exports = {
  getGroupDebts: async () => ({
    owedToMe: [{ slug: 'alex', amount: 20 }],
  }),
};
`);
    env.COLLECTION_EVENT = 'trip';
    env.COLLECTION_RULES_PATH = configPath;
  } else {
    const configPath = path.join(dir, 'build-rules-config.json');
    fs.writeFileSync(configPath, JSON.stringify({ skipPatterns: ['fixture-never-matches'] }));
    env.BUILD_RULES_CONFIG_PATH = configPath;
  }

  const result = spawnSync(process.execPath, [path.join(dir, scriptName)], {
    cwd: dir,
    env,
    encoding: 'utf8',
  });
  return { result, calls: readCalls(env.MOCK_CALLS_PATH) };
}

function mutationCallNames(calls) {
  const relevant = new Set(['updateTransaction', 'createRule', 'sync', 'shutdown']);
  return calls.filter((call) => relevant.has(call.name)).map((call) => call.name);
}

test('event-collect syncs each confirmed tag as a resume checkpoint', (t) => {
  const { result, calls } = runMutationTool(t, 'event-collect.js');

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(mutationCallNames(calls), [
    'updateTransaction',
    'sync',
    'updateTransaction',
    'sync',
    'shutdown',
  ]);
  assert.match(result.stdout, /APPLIED: 2 repayment\(s\)/);
});

test('event-collect exits nonzero after a mid-loop fault with prior work synced', (t) => {
  const { result, calls } = runMutationTool(t, 'event-collect.js', { fail: 'second-update' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mock-second-update-failure/);
  assert.deepEqual(mutationCallNames(calls), [
    'updateTransaction',
    'sync',
    'updateTransaction',
    'shutdown',
  ]);
  assert.doesNotMatch(result.stdout, /APPLIED/);
});

test('build-rules syncs confirmed rule creation before reporting success', (t) => {
  const { result, calls } = runMutationTool(t, 'build-rules.js');

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(mutationCallNames(calls), [
    'createRule',
    'createRule',
    'sync',
    'shutdown',
  ]);
  assert.match(result.stdout, /APPLIED — created 2 rules/);
});

test('build-rules exits nonzero and shuts down when sync fails', (t) => {
  const { result, calls } = runMutationTool(t, 'build-rules.js', { fail: 'sync' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mock-sync-failure/);
  assert.deepEqual(mutationCallNames(calls), [
    'createRule',
    'createRule',
    'sync',
    'shutdown',
  ]);
  assert.doesNotMatch(result.stdout, /APPLIED/);
});

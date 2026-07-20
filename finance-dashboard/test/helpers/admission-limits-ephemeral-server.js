'use strict';

const path = require('path');
const { sidecarReleasePrelude } = require('./test-sync-barriers');
const { startEphemeralDashboardServer } = require('./ephemeral-dashboard-server');

const ADMISSION_PRELOAD_BODY = `
    const fs = require('fs');
    const path = require('path');
    const root = process.env.TEST_DASHBOARD_ROOT;
    const dataPath = require.resolve(path.join(root, 'dataModule.js'));
    const mark = (value) => fs.appendFileSync(process.env.TEST_EFFECT_MARKER, value + '\\n');
    ${sidecarReleasePrelude()}
    const waitForRelease = waitSidecarRelease;
    const mock = new Proxy({
      initApi: async () => ({ ok: true }),
      shutdownApi: async () => ({ ok: true }),
      getHealth: () => ({ ready: true }),
      getAccounts: async () => {
        mark('accounts:start');
        await waitForRelease();
        mark('accounts:end');
        return [{ id: 'a1', name: 'Checking' }];
      },
      getBudgets: async ({ month }) => {
        mark('budget-read:' + (month || 'current'));
        return { month: month || '2026-07', categories: [] };
      },
      setBudgetAmount: async ({ month, categoryId, amount }) => {
        mark('budget:start');
        await waitForRelease();
        mark('budget:end:' + (month || 'unknown'));
        return { ok: true, month, categoryId, amount };
      },
      setOwesConfig: async (config) => {
        mark('setOwes:' + Object.keys(config || {}).sort().join(','));
        return { ok: true };
      },
      getReceiptFile: async ({ id }) => {
        mark('receipt-image:start:' + id);
        await waitForRelease();
        mark('receipt-image:end:' + id);
        const receiptPath = process.env.TEST_RECEIPT_PATH;
        if (!receiptPath) return null;
        return { path: receiptPath, mime: 'image/png' };
      },
    }, {
      get(target, property) {
        if (property in target) return target[property];
        return async () => [];
      },
    });
    require.cache[dataPath] = {
      id: dataPath,
      filename: dataPath,
      loaded: true,
      exports: mock,
      children: [],
      paths: [],
    };
  `;

const DEFAULT_ADMISSION_ENV = {
  SELFTEST: '1',
  FINANCE_ADMISSION_READ_GLOBAL_PENDING: '4',
  FINANCE_ADMISSION_READ_GLOBAL_RUNNING: '1',
  FINANCE_ADMISSION_READ_PRINCIPAL_PENDING: '2',
  FINANCE_ADMISSION_READ_PRINCIPAL_RUNNING: '1',
  FINANCE_ADMISSION_MUTATION_GLOBAL_PENDING: '4',
  FINANCE_ADMISSION_MUTATION_GLOBAL_RUNNING: '1',
  FINANCE_ADMISSION_MUTATION_PRINCIPAL_PENDING: '2',
  FINANCE_ADMISSION_MUTATION_PRINCIPAL_RUNNING: '1',
  FINANCE_ADMISSION_LIGHTWEIGHT_GLOBAL_PENDING: '2',
  FINANCE_ADMISSION_LIGHTWEIGHT_GLOBAL_RUNNING: '1',
  FINANCE_ADMISSION_MAX_PENDING_DEPTH: '3',
  FINANCE_ADMISSION_CONTROL_RESERVE: '1',
  FINANCE_ADMISSION_RECOVERY_RESERVE: '1',
  FINANCE_ADMISSION_CHEAP_RESERVE: '1',
  FINANCE_ADMISSION_MAX_WAIT_MS: '25',
};

function tightAdmissionEnv(overrides = {}) {
  return {
    FINANCE_ADMISSION_MUTATION_GLOBAL_PENDING: '2',
    FINANCE_ADMISSION_MUTATION_GLOBAL_RUNNING: '1',
    FINANCE_ADMISSION_MUTATION_PRINCIPAL_PENDING: '1',
    FINANCE_ADMISSION_MUTATION_PRINCIPAL_RUNNING: '1',
    FINANCE_ADMISSION_READ_GLOBAL_PENDING: '1',
    FINANCE_ADMISSION_READ_GLOBAL_RUNNING: '1',
    FINANCE_ADMISSION_READ_PRINCIPAL_PENDING: '1',
    FINANCE_ADMISSION_READ_PRINCIPAL_RUNNING: '1',
    FINANCE_ADMISSION_LIGHTWEIGHT_GLOBAL_PENDING: '1',
    FINANCE_ADMISSION_LIGHTWEIGHT_GLOBAL_RUNNING: '1',
    FINANCE_ADMISSION_MAX_PENDING_DEPTH: '1',
    FINANCE_ADMISSION_CONTROL_RESERVE: '0',
    FINANCE_ADMISSION_RECOVERY_RESERVE: '1',
    FINANCE_ADMISSION_CHEAP_RESERVE: '0',
    ...overrides,
  };
}

async function startAdmissionLimitsServer(t, { tempPrefix, admissionEnv = {} } = {}) {
  let releasePath;
  const started = await startEphemeralDashboardServer(t, {
    tempPrefix,
    preloadBody: ADMISSION_PRELOAD_BODY,
    extraEnvForDir: (dir) => {
      releasePath = path.join(dir, 'release.barrier');
      return {
        ...DEFAULT_ADMISSION_ENV,
        ...admissionEnv,
        TEST_RELEASE_PATH: releasePath,
      };
    },
  });
  return {
    ...started,
    releasePath,
    marker: started.effectMarkerPath,
    journalPath: path.join(started.dir, 'operation-journal.json'),
  };
}

module.exports = {
  ADMISSION_PRELOAD_BODY,
  DEFAULT_ADMISSION_ENV,
  tightAdmissionEnv,
  startAdmissionLimitsServer,
};

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { QueryClient, QueryObserver } = require('@tanstack/react-query');
const {
  FINANCE_QUERY_SCOPE_META_KEY,
  FOREGROUND_COMPLETION_REFRESH_ERROR_CODE,
  reconcileFinanceOperationsOnForeground,
  refreshActiveFinanceQueriesForScope,
} = require('../src/lib/foreground-operation-reconciliation');
const {
  createReconciliationDiagnosticStore,
  createRequestOperationMachine,
} = require('../src/lib/request-operation-state');

const CURRENT_SCOPE = 'server-current';
const OTHER_SCOPE = 'server-other';
const operationScope = crypto.createHash('sha256').update('foreground-profile').digest('hex');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
      },
    },
  });
}

function activateFinanceQuery(client, {
  key,
  scope = CURRENT_SCOPE,
  initialData,
  queryFn,
}) {
  client.setQueryData(key, initialData);
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn,
    retry: false,
    staleTime: Infinity,
    meta: { [FINANCE_QUERY_SCOPE_META_KEY]: scope },
  });
  const unsubscribe = observer.subscribe(() => {});
  return {
    observer,
    query: () => client.getQueryCache().find({ queryKey: key, exact: true }),
    unsubscribe,
  };
}

function operationMachine() {
  let snapshot = null;
  let keyCreations = 0;
  const machine = createRequestOperationMachine({
    store: {
      read: () => snapshot,
      write: (next) => {
        snapshot = structuredClone(next);
      },
    },
    hash,
    keyFactory: () => {
      keyCreations += 1;
      return `ios-foreground-${String(keyCreations).padStart(8, '0')}`;
    },
    now: (() => {
      let value = 1_700_000_000_000;
      return () => ++value;
    })(),
  });
  return { machine, keyCreations: () => keyCreations };
}

function prepareDispatchedOperation(machine) {
  const record = machine.prepare({
    scopeDigest: operationScope,
    method: 'POST',
    endpoint: '/api/v1/transactions',
    body: { amount: 42, accountId: 'account-1' },
  });
  machine.markDispatching(record.requestDigest);
  return record;
}

function diagnosticStore() {
  let value = null;
  const diagnostics = createReconciliationDiagnosticStore({
    read: () => value,
    write: (next) => {
      value = next;
    },
  }, () => 1_700_000_000_123);
  return { diagnostics, raw: () => value };
}

test('completed foreground recovery invalidates and refetches active current-profile finance queries', async () => {
  const client = queryClient();
  let queryRequests = 0;
  let diagnosticClears = 0;
  const current = activateFinanceQuery(client, {
    key: ['today', CURRENT_SCOPE],
    initialData: { balance: 10 },
    queryFn: async () => {
      queryRequests += 1;
      return { balance: 20 };
    },
  });

  try {
    const summary = await reconcileFinanceOperationsOnForeground({
      reconcile: async () => ({ checked: 1, completed: 1, failed: 0, unresolved: 0 }),
      refreshCompletedQueries: () => {
        const refresh = refreshActiveFinanceQueriesForScope(client, CURRENT_SCOPE);
        assert.equal(current.query().state.isInvalidated, true);
        return refresh;
      },
      clearDiagnostic: () => {
        diagnosticClears += 1;
      },
      recordDiagnostic: assert.fail,
    });

    assert.deepEqual(summary, { checked: 1, completed: 1, failed: 0, unresolved: 0 });
    assert.equal(queryRequests, 1);
    assert.deepEqual(client.getQueryData(['today', CURRENT_SCOPE]), { balance: 20 });
    assert.equal(current.query().state.isInvalidated, false);
    assert.equal(diagnosticClears, 1);

    const layoutSource = fs.readFileSync(path.join(__dirname, '../src/app/_layout.tsx'), 'utf8');
    const requestsSource = fs.readFileSync(
      path.join(__dirname, '../src/api/client/requests.ts'),
      'utf8',
    );
    assert.match(
      layoutSource,
      /refreshActiveFinanceQueriesForScope\(queryClient,\s*scope\)/,
    );
    assert.match(requestsSource, /\[FINANCE_QUERY_SCOPE_META_KEY\]:\s*scope/);
  } finally {
    current.unsubscribe();
    client.clear();
  }
});

test('foreground completion does not invalidate or refetch another profile', async () => {
  const client = queryClient();
  let currentRequests = 0;
  let otherRequests = 0;
  const current = activateFinanceQuery(client, {
    key: ['accounts', CURRENT_SCOPE],
    initialData: { version: 'old-current' },
    queryFn: async () => {
      currentRequests += 1;
      return { version: 'new-current' };
    },
  });
  const other = activateFinanceQuery(client, {
    key: ['accounts', OTHER_SCOPE],
    scope: OTHER_SCOPE,
    initialData: { version: 'other' },
    queryFn: async () => {
      otherRequests += 1;
      return { version: 'wrong' };
    },
  });

  try {
    await refreshActiveFinanceQueriesForScope(client, CURRENT_SCOPE);
    assert.equal(currentRequests, 1);
    assert.equal(otherRequests, 0);
    assert.deepEqual(client.getQueryData(['accounts', OTHER_SCOPE]), { version: 'other' });
    assert.equal(other.query().state.isInvalidated, false);
  } finally {
    current.unsubscribe();
    other.unsubscribe();
    client.clear();
  }
});

test('foreground completion recovery sends zero mutation requests and no haptics', async () => {
  const { machine } = operationMachine();
  const pending = prepareDispatchedOperation(machine);
  let mutationRequests = 0;
  let statusRequests = 0;
  let refreshes = 0;

  const summary = await reconcileFinanceOperationsOnForeground({
    reconcile: () => machine.reconcileProfile(operationScope, async (key) => {
      statusRequests += 1;
      assert.equal(key, pending.idempotencyKey);
      return { status: 'completed', result: { transactionId: 'txn-recovered' } };
    }),
    refreshCompletedQueries: async () => {
      refreshes += 1;
    },
    clearDiagnostic: () => {},
    recordDiagnostic: assert.fail,
  });

  assert.deepEqual(summary, { checked: 1, completed: 1, failed: 0, unresolved: 0 });
  assert.equal(statusRequests, 1);
  assert.equal(refreshes, 1);
  assert.equal(mutationRequests, 0);
  assert.equal(machine.listRecords(operationScope).length, 0);

  const layoutSource = fs.readFileSync(path.join(__dirname, '../src/app/_layout.tsx'), 'utf8');
  const helperSource = fs.readFileSync(
    path.join(__dirname, '../src/lib/foreground-operation-reconciliation.js'),
    'utf8',
  );
  assert.doesNotMatch(layoutSource, /haptics?\./i);
  assert.doesNotMatch(helperSource, /haptics?\./i);
});

test('failed-only and unresolved-only summaries do not refresh completion queries', async () => {
  for (const summary of [
    { checked: 1, completed: 0, failed: 1, unresolved: 0 },
    { checked: 1, completed: 0, failed: 0, unresolved: 1 },
  ]) {
    let refreshes = 0;
    const result = await reconcileFinanceOperationsOnForeground({
      reconcile: async () => summary,
      refreshCompletedQueries: async () => {
        refreshes += 1;
      },
      clearDiagnostic: () => {},
      recordDiagnostic: assert.fail,
    });
    assert.deepEqual(result, summary);
    assert.equal(refreshes, 0);
  }
});

test('completion refetch failure leaves queries stale and records only a redacted diagnostic', async () => {
  const client = queryClient();
  const { diagnostics, raw } = diagnosticStore();
  let recorded;
  const current = activateFinanceQuery(client, {
    key: ['transactions', CURRENT_SCOPE],
    initialData: { items: ['stale'] },
    queryFn: async () => {
      throw Object.assign(new Error('private refetch failure'), {
        status: 503,
        token: 'private-token',
        body: { amount: 9876.54 },
      });
    },
  });

  try {
    const summary = await reconcileFinanceOperationsOnForeground({
      reconcile: async () => ({ checked: 1, completed: 1, failed: 0, unresolved: 0 }),
      refreshCompletedQueries: () => refreshActiveFinanceQueriesForScope(client, CURRENT_SCOPE),
      clearDiagnostic: assert.fail,
      recordDiagnostic: (error) => {
        recorded = error;
        diagnostics.record(error);
      },
    });

    assert.equal(summary.completed, 1);
    assert.equal(current.query().state.isInvalidated, true);
    assert.deepEqual(recorded, {
      code: FOREGROUND_COMPLETION_REFRESH_ERROR_CODE,
      status: 503,
    });
    assert.deepEqual(diagnostics.get(), {
      code: FOREGROUND_COMPLETION_REFRESH_ERROR_CODE,
      status: 503,
      timestamp: 1_700_000_000_123,
    });
    assert.doesNotMatch(raw(), /private|9876\.54/i);
  } finally {
    current.unsubscribe();
    client.clear();
  }
});

test('later screen refresh observes recovered state without creating a new mutation key', async () => {
  const client = queryClient();
  const { machine, keyCreations } = operationMachine();
  const pending = prepareDispatchedOperation(machine);
  const { diagnostics } = diagnosticStore();
  let queryRequests = 0;
  let mutationRequests = 0;
  let statusRequests = 0;
  const current = activateFinanceQuery(client, {
    key: ['transactions', CURRENT_SCOPE],
    initialData: { items: [] },
    queryFn: async () => {
      queryRequests += 1;
      if (queryRequests === 1) {
        throw Object.assign(new Error('temporary read failure'), { status: 503 });
      }
      return { items: [{ id: 'txn-recovered' }] };
    },
  });

  try {
    const summary = await reconcileFinanceOperationsOnForeground({
      reconcile: () => machine.reconcileProfile(operationScope, async (key) => {
        statusRequests += 1;
        assert.equal(key, pending.idempotencyKey);
        return { status: 'completed', result: { transactionId: 'txn-recovered' } };
      }),
      refreshCompletedQueries: () => refreshActiveFinanceQueriesForScope(client, CURRENT_SCOPE),
      clearDiagnostic: diagnostics.clear,
      recordDiagnostic: diagnostics.record,
    });

    assert.equal(summary.completed, 1);
    assert.equal(current.query().state.isInvalidated, true);
    assert.equal(machine.listRecords(operationScope).length, 0);
    assert.equal(keyCreations(), 1);
    assert.equal(mutationRequests, 0);
    assert.equal(statusRequests, 1);

    await current.observer.refetch({ throwOnError: true });
    assert.deepEqual(client.getQueryData(['transactions', CURRENT_SCOPE]), {
      items: [{ id: 'txn-recovered' }],
    });
    assert.equal(current.query().state.isInvalidated, false);
    assert.equal(keyCreations(), 1);
    assert.equal(mutationRequests, 0);
    assert.equal(statusRequests, 1);
  } finally {
    current.unsubscribe();
    client.clear();
  }
});

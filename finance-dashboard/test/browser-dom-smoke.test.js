const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('node:url');
const { verifyNoInlineBrowserStyles } = require('../lib/browser-style-policy');
const { listModuleFiles } = require('../lib/browser-static');

const dashboardRoot = path.resolve(__dirname, '..');
const publicRoot = path.join(dashboardRoot, 'public');
const indexHtml = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
const loginHtml = fs.readFileSync(path.join(publicRoot, 'login.html'), 'utf8');

function createClassList(backing = new Set()) {
  return {
    add(...names) { names.forEach((name) => backing.add(name)); },
    remove(...names) { names.forEach((name) => backing.delete(name)); },
    toggle(name, force) {
      const next = force ?? !backing.has(name);
      if (next) backing.add(name);
      else backing.delete(name);
      return next;
    },
    contains(name) { return backing.has(name); },
  };
}

function createContainer(tag, id) {
  const node = createElement(tag, id);
  let html = '';
  const queryCache = new Map();
  Object.defineProperty(node, 'innerHTML', {
    get() { return html; },
    set(value) {
      html = value;
      queryCache.clear();
    },
  });
  node.querySelectorAll = (selector) => {
    if (selector === '[data-goal-index]') {
      return [...html.matchAll(/data-goal-index="(\d+)"/g)].map((match) => ({
        dataset: { goalIndex: match[1] },
        addEventListener() {},
      }));
    }
    if (selector === '[data-category]') {
      return [...html.matchAll(/data-category="([^"]+)"/g)].map((match) => ({
        dataset: { category: match[1] },
        addEventListener() {},
      }));
    }
    if (selector === '[data-categorize-index]') return [];
    if (selector === '[data-sub-key]') {
      if (!queryCache.has(selector)) {
        const buttons = [...html.matchAll(/<button\b([^>]*)>/g)].flatMap((match) => {
          const attrs = Object.fromEntries(
            [...match[1].matchAll(/\b(data-[a-z-]+)="([^"]*)"/g)]
              .map((attribute) => [attribute[1], attribute[2]]),
          );
          if (!attrs['data-sub-key']) return [];
          const button = createElement('button');
          button.dataset.subKey = attrs['data-sub-key'];
          if (attrs['data-sub-status']) button.dataset.subStatus = attrs['data-sub-status'];
          if (attrs['data-sub-hidden']) button.dataset.subHidden = attrs['data-sub-hidden'];
          return [button];
        });
        queryCache.set(selector, buttons);
      }
      return queryCache.get(selector);
    }
    return [];
  };
  return node;
}

function createElement(tag, id) {
  const classes = new Set();
  const listeners = new Map();
  const classList = createClassList(classes);
  const node = {
    tagName: tag.toUpperCase(),
    id,
    classList,
    hidden: false,
    disabled: false,
    innerHTML: '',
    textContent: '',
    value: '',
    children: [],
    dataset: {},
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    click() {
      for (const handler of listeners.get('click') || []) handler({ preventDefault() {} });
    },
    querySelectorAll(selector) {
      if (selector === '[data-goal-index]') {
        return [...node.children];
      }
      if (selector === '[data-category]') {
        return [...node.children];
      }
      return [];
    },
    querySelector() { return null; },
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    focus() {},
  };
  Object.defineProperty(node, 'className', {
    get() { return [...classes].join(' '); },
    set(value) {
      classes.clear();
      value.split(/\s+/).filter(Boolean).forEach((name) => classes.add(name));
    },
  });
  Object.defineProperty(node, 'outerHTML', {
    get() {
      const attrs = [];
      if (node.hidden) attrs.push('hidden');
      if (node.className) attrs.push(`class="${node.className}"`);
      for (const [key, value] of Object.entries(node.dataset)) attrs.push(`data-${key}="${value}"`);
      const attrText = attrs.length ? ` ${attrs.join(' ')}` : '';
      return `<${tag}${attrText}>${node.innerHTML}</${tag}>`;
    },
  });
  return node;
}

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function installBrowserGlobals() {
  const elements = new Map();
  const bodyClasses = new Set();
  const storage = createMemoryStorage();
  const alerts = [];
  let reloads = 0;
  const document = {
    body: { classList: createClassList(bodyClasses) },
    querySelectorAll(selector) {
      if (selector === '.filter-btn') return [];
      return [];
    },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement('div', id));
      return elements.get(id);
    },
  };
  globalThis.document = document;
  globalThis.window = globalThis;
  globalThis.location = { pathname: '/', reload() { reloads += 1; } };
  globalThis.localStorage = storage;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  globalThis.Chart = class Chart {
    constructor() {}
    update() {}
    destroy() {}
  };
  globalThis.navigator = { credentials: { get: async () => ({}), create: async () => ({}) } };
  globalThis.alert = (message) => alerts.push(String(message));
  globalThis.confirm = () => true;
  globalThis.console = { error() {}, log() {} };
  return {
    alerts,
    document,
    elements,
    reloads: () => reloads,
    storage,
  };
}

function assertNoInlineStyleMarkup(markup, label) {
  assert.doesNotMatch(markup, /\bstyle\s*=/i, `${label} must not emit inline style attributes`);
}

function parseModuleGraph(entryPath) {
  const graph = new Map();
  const queue = [entryPath];
  while (queue.length) {
    const file = queue.shift();
    if (graph.has(file)) continue;
    const absolute = path.join(publicRoot, file);
    const source = fs.readFileSync(absolute, 'utf8');
    graph.set(file, []);
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      if (!spec.startsWith('.')) continue;
      const dep = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      graph.get(file).push(dep);
      queue.push(dep);
    }
  }
  return graph;
}

function findImportCycles(graph) {
  const cycles = [];
  const visiting = new Set();
  const visited = new Set();
  function walk(node, stack) {
    if (visiting.has(node)) {
      cycles.push([...stack, node]);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const dep of graph.get(node) || []) walk(dep, [...stack, node]);
    visiting.delete(node);
    visited.add(node);
  }
  for (const node of graph.keys()) walk(node, []);
  return cycles;
}

test('browser style policy rejects inline style attributes in HTML and JS templates', () => {
  assert.doesNotThrow(() => verifyNoInlineBrowserStyles());
  assert.doesNotMatch(indexHtml, /\bstyle\s*=/i);
  assert.doesNotMatch(loginHtml, /\bstyle\s*=/i);
});

test('browser goal writes use journaled v1 requests with a fresh UUID per action', async () => {
  const { elements } = installBrowserGlobals();
  elements.set('goalsCard', createContainer('div', 'goalsCard'));
  elements.set('goalModal', createElement('div', 'goalModal'));
  for (const id of ['goalId', 'goalName', 'goalTarget', 'goalCurrent', 'goalDeadline', 'goalAccount']) {
    elements.set(id, createElement('input', id));
  }
  elements.get('goalName').value = 'Emergency';
  elements.get('goalTarget').value = '1000';
  elements.get('goalCurrent').value = '100';

  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/goals') return { ok: true, json: async () => [] };
    return { ok: true, json: async () => ({ data: { ok: true } }) };
  };

  const { submitGoal } = await import(pathToFileURL(path.join(publicRoot, 'js/render/goals.js')).href);
  await submitGoal();
  await submitGoal();

  const mutations = calls.filter(({ url }) => url === '/api/v1/goals');
  assert.equal(mutations.length, 2);
  const keys = mutations.map(({ options }) => options.headers['Idempotency-Key']);
  for (const key of keys) {
    assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  }
  assert.notEqual(keys[0], keys[1]);
  assert.equal(mutations[0].options.method, 'POST');
  assert.equal(mutations[0].options.headers['Content-Type'], 'application/json');
});

test('browser operation lifecycle recovers response loss by status and gives later intent a new key', async () => {
  const { storage } = installBrowserGlobals();
  const {
    BROWSER_OPERATION_STORAGE_KEY,
    mutateFinance,
  } = await import(pathToFileURL(path.join(publicRoot, 'js/api.js')).href);
  const body = {
    name: 'private-goal-marker',
    target: 987654321.125,
    current: 123456789.875,
  };
  const mutationKeys = [];
  const statusKeys = [];
  let statusChecks = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/v1/goals?mode=replace') {
      const key = options.headers['Idempotency-Key'];
      mutationKeys.push(key);
      if (mutationKeys.length === 1) throw new Error('response lost');
      return jsonResponse(200, {
        data: { saved: true },
        operation: { key, replayed: false },
      });
    }
    if (url.startsWith('/api/v1/operations/')) {
      const key = decodeURIComponent(url.slice('/api/v1/operations/'.length));
      statusKeys.push(key);
      statusChecks += 1;
      if (statusChecks === 1) {
        return jsonResponse(200, {
          data: { key, status: 'started', phase: 'started', outcome: 'unknown' },
        });
      }
      return jsonResponse(200, {
        data: {
          key,
          status: 'completed',
          phase: 'completed',
          outcome: 'completed',
          result: { recovered: true },
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await assert.rejects(
    mutateFinance('/goals?mode=replace', { body }),
    (error) => error.code === 'OUTCOME_UNKNOWN'
      && error.requiresIdempotencyKeyReuse === true,
  );

  const rawPending = storage.getItem(BROWSER_OPERATION_STORAGE_KEY);
  const pending = JSON.parse(rawPending);
  const records = Object.values(pending.operations);
  assert.equal(records.length, 1);
  assert.deepEqual(Object.keys(records[0]).sort(), [
    'createdAt',
    'dispatchStartedAt',
    'fingerprint',
    'key',
    'outcomeUnknownAt',
    'state',
    'updatedAt',
    'version',
  ]);
  assert.match(records[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(records[0].key, mutationKeys[0]);
  assert.equal(records[0].state, 'outcome_unknown');
  assert.ok(records[0].createdAt <= records[0].dispatchStartedAt);
  assert.ok(records[0].dispatchStartedAt <= records[0].outcomeUnknownAt);
  assert.ok(records[0].outcomeUnknownAt <= records[0].updatedAt);
  for (const forbidden of [
    '/api/v1',
    'goals',
    'mode=replace',
    'private-goal-marker',
    '987654321.125',
    '123456789.875',
  ]) {
    assert.equal(rawPending.includes(forbidden), false, `pending state must not persist ${forbidden}`);
  }

  const recovered = await mutateFinance('/goals?mode=replace', { body });
  assert.equal(recovered.ok, true);
  assert.deepEqual((await recovered.json()).data, { recovered: true });
  assert.equal(mutationKeys.length, 1);
  assert.deepEqual(statusKeys, [mutationKeys[0], mutationKeys[0]]);
  assert.deepEqual(
    JSON.parse(storage.getItem(BROWSER_OPERATION_STORAGE_KEY)).operations,
    {},
  );

  await mutateFinance('/goals?mode=replace', { body });
  assert.equal(mutationKeys.length, 2);
  assert.notEqual(mutationKeys[1], mutationKeys[0]);
  assert.equal(statusKeys.length, 2);
});

test('browser admission and capacity responses preserve a prepared key for user retry', async (t) => {
  for (const fixture of [
    {
      name: 'journal capacity 503',
      status: 503,
      code: 'OPERATION_JOURNAL_CAPACITY_EXCEEDED',
      message: 'Operation journal nonterminal capacity reached',
    },
    {
      name: 'admission 429 without key-reuse metadata',
      status: 429,
      code: 'ADMISSION_OVERLOADED',
      message: 'Too many requests',
    },
  ]) {
    await t.test(fixture.name, async () => {
      const { storage } = installBrowserGlobals();
      const {
        BROWSER_OPERATION_STORAGE_KEY,
        mutateFinance,
      } = await import(pathToFileURL(path.join(publicRoot, 'js/api.js')).href);
      const mutationKeys = [];
      let statusPolls = 0;
      globalThis.fetch = async (url, options = {}) => {
        if (url === '/api/v1/refresh') {
          const key = options.headers['Idempotency-Key'];
          mutationKeys.push(key);
          if (mutationKeys.length === 1) {
            return jsonResponse(fixture.status, {
              error: fixture.message,
              code: fixture.code,
            });
          }
          return jsonResponse(200, {
            data: { refreshed: true },
            operation: { key, replayed: false },
          });
        }
        if (url.startsWith('/api/v1/operations/')) {
          statusPolls += 1;
          return jsonResponse(404, {
            error: 'Operation not found',
            code: 'OPERATION_NOT_FOUND',
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      };

      await assert.rejects(
        mutateFinance('/refresh'),
        (error) => error.status === fixture.status
          && error.code === fixture.code
          && error.requiresIdempotencyKeyReuse === true,
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(mutationKeys.length, 1);
      assert.equal(statusPolls, 0);

      const records = Object.values(
        JSON.parse(storage.getItem(BROWSER_OPERATION_STORAGE_KEY)).operations,
      );
      assert.equal(records.length, 1);
      assert.equal(records[0].state, 'prepared');
      assert.equal(records[0].key, mutationKeys[0]);
      assert.equal(Object.hasOwn(records[0], 'dispatchStartedAt'), false);
      assert.equal(Object.hasOwn(records[0], 'outcomeUnknownAt'), false);

      const retried = await mutateFinance('/refresh');
      assert.equal(retried.ok, true);
      assert.equal(mutationKeys.length, 2);
      assert.equal(mutationKeys[1], mutationKeys[0]);
      assert.equal(statusPolls, 0);
      assert.deepEqual(
        JSON.parse(storage.getItem(BROWSER_OPERATION_STORAGE_KEY)).operations,
        {},
      );
    });
  }
});

test('malformed 503 remains uncertain and is never treated as safe admission rejection', async () => {
  const { storage } = installBrowserGlobals();
  const {
    BROWSER_OPERATION_STORAGE_KEY,
    mutateFinance,
  } = await import(pathToFileURL(path.join(publicRoot, 'js/api.js')).href);
  let mutationCalls = 0;
  let statusPolls = 0;
  globalThis.fetch = async (url) => {
    if (url === '/api/v1/refresh') {
      mutationCalls += 1;
      return jsonResponse(503, { error: 'Malformed service response without a code' });
    }
    if (url.startsWith('/api/v1/operations/')) {
      statusPolls += 1;
      const key = decodeURIComponent(url.slice('/api/v1/operations/'.length));
      return jsonResponse(200, {
        data: { key, status: 'started', phase: 'started', outcome: 'unknown' },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await assert.rejects(mutateFinance('/refresh'), (error) => error.code === 'OUTCOME_UNKNOWN');
  assert.equal(mutationCalls, 1);
  assert.equal(statusPolls, 1);
  const records = Object.values(
    JSON.parse(storage.getItem(BROWSER_OPERATION_STORAGE_KEY)).operations,
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].state, 'outcome_unknown');
});

test('browser operation lifecycle clears a failed terminal status and returns its envelope error', async () => {
  const { storage } = installBrowserGlobals();
  const {
    BROWSER_OPERATION_STORAGE_KEY,
    mutateFinance,
  } = await import(pathToFileURL(path.join(publicRoot, 'js/api.js')).href);
  let mutationCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/v1/goals') {
      mutationCalls += 1;
      return jsonResponse(409, {
        error: 'The request outcome is unknown',
        code: 'OUTCOME_UNKNOWN',
      });
    }
    if (url.startsWith('/api/v1/operations/')) {
      const key = decodeURIComponent(url.slice('/api/v1/operations/'.length));
      assert.equal(key.length > 0, true);
      return jsonResponse(200, {
        data: {
          key,
          status: 'failed',
          phase: 'failed',
          outcome: 'failed',
          error: {
            status: 422,
            code: 'INVALID_GOAL',
            message: 'Goal input is invalid',
          },
        },
      });
    }
    throw new Error(`Unexpected request: ${url} ${options.method || 'GET'}`);
  };

  await assert.rejects(
    mutateFinance('/goals', { body: { name: 'invalid', target: -1 } }),
    (error) => error.status === 422
      && error.code === 'INVALID_GOAL'
      && error.message === 'Goal input is invalid',
  );
  assert.equal(mutationCalls, 1);
  assert.deepEqual(
    JSON.parse(storage.getItem(BROWSER_OPERATION_STORAGE_KEY)).operations,
    {},
  );
});

test('unknown operation status retains one key and never automatically replays the write', async () => {
  const { storage } = installBrowserGlobals();
  const {
    BROWSER_OPERATION_STORAGE_KEY,
    mutateFinance,
  } = await import(pathToFileURL(path.join(publicRoot, 'js/api.js')).href);
  const statusKeys = [];
  let mutationCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/v1/refresh') {
      mutationCalls += 1;
      return jsonResponse(409, {
        error: 'The request outcome is unknown',
        code: 'OUTCOME_UNKNOWN',
      });
    }
    if (url.startsWith('/api/v1/operations/')) {
      const key = decodeURIComponent(url.slice('/api/v1/operations/'.length));
      statusKeys.push(key);
      if (statusKeys.length === 1) {
        return jsonResponse(200, {
          data: { key, status: 'started', phase: 'sync_unknown', outcome: 'unknown' },
        });
      }
      return jsonResponse(404, {
        error: 'Operation not found',
        code: 'OPERATION_NOT_FOUND',
      });
    }
    throw new Error(`Unexpected request: ${url} ${options.method || 'GET'}`);
  };

  await assert.rejects(mutateFinance('/refresh'), (error) => error.code === 'OUTCOME_UNKNOWN');
  await assert.rejects(mutateFinance('/refresh'), (error) => error.code === 'OUTCOME_UNKNOWN');
  assert.equal(mutationCalls, 1);
  assert.equal(statusKeys.length, 2);
  assert.equal(statusKeys[1], statusKeys[0]);
  const records = Object.values(
    JSON.parse(storage.getItem(BROWSER_OPERATION_STORAGE_KEY)).operations,
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].key, statusKeys[0]);
  assert.equal(records[0].state, 'outcome_unknown');
});

test('goal and refresh callers keep UI state on terminal and unresolved mutation failures', async () => {
  let globals = installBrowserGlobals();
  globals.elements.set('goalsCard', createContainer('div', 'goalsCard'));
  globals.elements.set('goalModal', createElement('div', 'goalModal'));
  globals.elements.get('goalModal').classList.add('open');
  for (const id of ['goalId', 'goalName', 'goalTarget', 'goalCurrent', 'goalDeadline', 'goalAccount']) {
    globals.elements.set(id, createElement('input', id));
  }
  globals.elements.get('goalName').value = 'Emergency';
  globals.elements.get('goalTarget').value = '1000';
  globals.elements.get('goalCurrent').value = '100';
  let goalLoads = 0;
  globalThis.fetch = async (url) => {
    if (url === '/api/v1/goals') {
      return jsonResponse(422, {
        error: 'Goal input is invalid',
        code: 'INVALID_GOAL',
      });
    }
    if (url === '/api/goals') {
      goalLoads += 1;
      return jsonResponse(200, []);
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const { submitGoal } = await import(pathToFileURL(path.join(publicRoot, 'js/render/goals.js')).href);
  await assert.rejects(submitGoal(), (error) => error.code === 'INVALID_GOAL');
  assert.equal(globals.elements.get('goalModal').classList.contains('open'), true);
  assert.equal(goalLoads, 0);
  assert.match(globals.alerts[0], /Goal update failed: Goal input is invalid/);

  globals = installBrowserGlobals();
  let statusKey;
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/v1/refresh') {
      statusKey = options.headers['Idempotency-Key'];
      throw new Error('response lost');
    }
    if (url.startsWith('/api/v1/operations/')) {
      assert.equal(decodeURIComponent(url.slice('/api/v1/operations/'.length)), statusKey);
      return jsonResponse(200, {
        data: { key: statusKey, status: 'started', phase: 'started', outcome: 'unknown' },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const { refreshData } = await import(pathToFileURL(path.join(publicRoot, 'js/api.js')).href);
  await assert.rejects(refreshData(), (error) => error.code === 'OUTCOME_UNKNOWN');
  assert.equal(globals.reloads(), 0);
});

test('recurring caller does not refresh cards after an unresolved write', async () => {
  const { alerts, elements } = installBrowserGlobals();
  const recurringCard = createContainer('div', 'recurringCard');
  elements.set('recurringCard', recurringCard);
  elements.set('subSummary', createElement('div', 'subSummary'));
  let recurringLoads = 0;
  let billLoads = 0;
  let resolveMutation;
  const mutationStarted = new Promise((resolve) => {
    resolveMutation = resolve;
  });
  globalThis.fetch = async (url) => {
    if (url === '/api/recurring') {
      recurringLoads += 1;
      return jsonResponse(200, {
        count: 1,
        activeCount: 1,
        monthlyTotal: 10,
        annualTotal: 120,
        items: [{
          key: 'coffee',
          payee: 'Coffee',
          category: 'Food',
          cadence: 'monthly',
          amount: 10,
          status: 'active',
          occurrences: 2,
        }],
      });
    }
    if (url === '/api/bills') {
      billLoads += 1;
      return jsonResponse(200, { count: 0, bills: [] });
    }
    if (url === '/api/v1/recurring/coffee/override') {
      resolveMutation();
      return jsonResponse(409, {
        error: 'The request outcome is unknown',
        code: 'OUTCOME_UNKNOWN',
      });
    }
    if (url.startsWith('/api/v1/operations/')) {
      const key = decodeURIComponent(url.slice('/api/v1/operations/'.length));
      return jsonResponse(200, {
        data: { key, status: 'started', phase: 'local_applied', outcome: 'unknown' },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const { loadRecurring } = await import(pathToFileURL(path.join(publicRoot, 'js/render/recurring.js')).href);
  await loadRecurring();
  const [cancelButton] = recurringCard.querySelectorAll('[data-sub-key]');
  cancelButton.click();
  await mutationStarted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recurringLoads, 1);
  assert.equal(billLoads, 0);
  assert.match(alerts[0], /Recurring update failed: Request outcome is unknown/);
});

test('browser renderers emit semantic progress, palette classes, and hidden controls', async () => {
  const { elements } = installBrowserGlobals();
  const goalsCard = createContainer('div', 'goalsCard');
  elements.set('goalsCard', goalsCard);
  const goalDeleteBtn = createElement('button', 'goalDeleteBtn');
  goalDeleteBtn.hidden = true;
  elements.set('goalDeleteBtn', goalDeleteBtn);
  elements.set('goalModal', createElement('div', 'goalModal'));
  for (const id of ['goalModalTitle', 'goalId', 'goalName', 'goalTarget', 'goalAccount']) {
    elements.set(id, createElement('input', id));
  }

  globalThis.fetch = async (url) => {
    if (url === '/api/goals') {
      return { json: async () => [{ id: 'g1', name: 'Emergency', target: 1000, current: 450, pct: 45, accountId: null }] };
    }
    return { ok: true, json: async () => ({}) };
  };

  const { loadGoals, openGoalForm } = await import(pathToFileURL(path.join(publicRoot, 'js/render/goals.js')).href);
  await loadGoals();
  assertNoInlineStyleMarkup(goalsCard.innerHTML, 'goals');
  assert.match(goalsCard.innerHTML, /<progress class="bar-progress" value="45" max="100"/);
  openGoalForm(0);
  assert.equal(goalDeleteBtn.hidden, false);

  const budgetCard = createContainer('div', 'budgetCard');
  elements.set('budgetCard', budgetCard);
  elements.set('budgetMeta', createElement('span', 'budgetMeta'));
  globalThis.fetch = async (url) => {
    if (url.startsWith('/api/budgets')) {
      return {
        json: async () => ({
          supported: true,
          totalBudgeted: 100,
          groups: [{
            name: 'Monthly',
            spent: 80,
            budgeted: 100,
            categories: [{ name: 'Food', spent: 80, budgeted: 100, over: true }],
          }],
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  };
  const { loadBudgets } = await import(pathToFileURL(path.join(publicRoot, 'js/render/budgets.js')).href);
  await loadBudgets();
  assertNoInlineStyleMarkup(budgetCard.innerHTML, 'budgets');
  assert.match(budgetCard.innerHTML, /<progress class="bar-progress bar-over" value="\d+" max="100"/);

  const categoryList = createContainer('div', 'categoryList');
  elements.set('categoryList', categoryList);
  for (const id of ['statSpent', 'statIncome', 'statNet', 'statSpentDelta', 'chartCenterAmt']) {
    elements.set(id, createElement('div', id));
  }
  elements.set('spendingChart', createElement('canvas', 'spendingChart'));
  elements.get('spendingChart').getContext = () => ({});
  globalThis.fetch = async (url) => {
    if (url.startsWith('/api/spending')) {
      return {
        json: async () => ({
          current: { totalSpend: 120, totalIncome: 200, spending: { Food: 80, Travel: 40 } },
          prev: { totalSpend: 100 },
          completeness: { complete: true },
          comparisonCompleteness: { complete: true },
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  };
  const { loadSpending } = await import(pathToFileURL(path.join(publicRoot, 'js/render/charts-pages.js')).href);
  await loadSpending();
  assertNoInlineStyleMarkup(categoryList.innerHTML, 'categories');
  assert.match(categoryList.innerHTML, /cat-dot cat-color-0/);
  assert.match(categoryList.innerHTML, /<progress class="cat-progress cat-color-0" value="\d+" max="100"/);
  assert.equal(elements.get('statNet').classList.contains('text-tone-green'), true);

  const reservedHost = createContainer('div', 'safeToSpendReserved');
  const reasonsHost = createContainer('div', 'safeToSpendReasons');
  elements.set('safeToSpendReserved', reservedHost);
  elements.set('safeToSpendReasons', reasonsHost);
  for (const id of ['safeToSpendValue', 'safeToSpendDetail', 'goalAdvisoryNote']) {
    elements.set(id, createElement('div', id));
  }
  const adversarial = '<img src=x onerror=alert(1)>&amp; "quoted"';
  const { renderSafeToSpend } = await import(pathToFileURL(path.join(publicRoot, 'js/render/safe-to-spend.js')).href);
  renderSafeToSpend(
    { complete: false, incompleteReasons: [adversarial] },
    {
      data: {
        obligations: {
          reserved: [{
            label: adversarial,
            amountCents: 12345,
            date: adversarial,
          }],
        },
      },
    },
  );
  assert.ok(!reservedHost.innerHTML.includes('<img'));
  assert.ok(!reasonsHost.innerHTML.includes('<img'));
  assert.match(reservedHost.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;&amp;amp; &quot;quoted&quot;/);
  assert.match(reasonsHost.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;&amp;amp; &quot;quoted&quot;/);

  const loadMoreBtn = createElement('button', 'loadMoreBtn');
  loadMoreBtn.hidden = true;
  elements.set('loadMoreBtn', loadMoreBtn);
  elements.set('txnBody', createContainer('tbody', 'txnBody'));
  elements.set('searchInput', createElement('input', 'searchInput'));
  const { renderTxns } = await import(pathToFileURL(path.join(publicRoot, 'js/render/transactions.js')).href);
  const { setAllTxns, state } = await import(pathToFileURL(path.join(publicRoot, 'js/state.js')).href);
  setAllTxns(Array.from({ length: 60 }, (_, i) => ({
    id: `t${i}`,
    date: '2026-07-01',
    payee: 'Coffee',
    account: 'Checking',
    category: 'Food',
    amount: -4,
    isLeg: true,
    notes: i === 0 ? 'note line' : '',
  })));
  state.txnPage = 50;
  renderTxns();
  assertNoInlineStyleMarkup(elements.get('txnBody').innerHTML, 'transactions');
  assert.match(elements.get('txnBody').innerHTML, /txn-notes/);
  assert.equal(loadMoreBtn.hidden, false);
  state.txnPage = 100;
  renderTxns();
  assert.equal(loadMoreBtn.hidden, true);
});

test('login enrollment flow toggles body classes without inline display styles', async () => {
  const { elements } = installBrowserGlobals();
  elements.set('signInBtn', createElement('button', 'signInBtn'));
  elements.set('registerBtn', createElement('a', 'registerBtn'));
  elements.set('status', createElement('div', 'status'));
  globalThis.fetch = async () => ({
    json: async () => ({ registered: false, enrollmentAvailable: true }),
  });
  await import(pathToFileURL(path.join(publicRoot, 'js/login.js')).href);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(globalThis.document.body.classList.contains('login-enroll'), true);
  assert.equal(globalThis.document.body.classList.contains('login-closed'), false);
});

test('browser module graph has no import cycles and ESM entry modules evaluate', async () => {
  const graph = parseModuleGraph('js/app.js');
  const cycles = findImportCycles(graph);
  assert.deepEqual(cycles, [], `import cycles detected: ${JSON.stringify(cycles)}`);
  installBrowserGlobals();
  for (const file of listModuleFiles()) {
    if (file === 'app.js' || file === 'login.js') continue;
    await import(pathToFileURL(path.join(publicRoot, 'js', file)).href);
  }
});

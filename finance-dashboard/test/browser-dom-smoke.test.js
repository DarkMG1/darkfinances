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
  Object.defineProperty(node, 'innerHTML', {
    get() { return html; },
    set(value) { html = value; },
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

function installBrowserGlobals() {
  const elements = new Map();
  const bodyClasses = new Set();
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
  globalThis.location = { pathname: '/', reload() {} };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  globalThis.Chart = class Chart {
    constructor() {}
    update() {}
    destroy() {}
  };
  globalThis.navigator = { credentials: { get: async () => ({}), create: async () => ({}) } };
  globalThis.alert = () => {};
  globalThis.confirm = () => true;
  globalThis.console = { error() {}, log() {} };
  return { document, elements };
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

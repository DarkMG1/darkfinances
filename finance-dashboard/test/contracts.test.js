const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
const generated = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'api', 'generated', 'endpoints.ts'), 'utf8');
const browser = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');
const appHome = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'app', '(tabs)', 'index.tsx'), 'utf8');

function serverRoutes() {
  const direct = [...server.matchAll(/\bv1\.(get|post|delete|put|patch)\('([^']+)'/g)]
    .map((match) => `${match[1].toUpperCase()} /api/v1${match[2]}`);
  const journaled = [...server.matchAll(/\bregisterV1Mutation\('([A-Z]+)', '([^']+)'/g)]
    .map((match) => `${match[1]} /api/v1${match[2]}`);
  return [...new Set([...direct, ...journaled])].sort();
}

function generatedRoutes() {
  return [...generated.matchAll(/\bdef\('([^']+)', '(GET|POST|DELETE|PUT|PATCH)'/g)]
    .map((match) => `${match[2]} ${match[1]}`)
    .sort();
}

test('native generated endpoint catalog matches every server route', () => {
  assert.deepEqual(generatedRoutes(), serverRoutes());
});

test('generated contract includes semimonthly cadence', () => {
  const types = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'api', 'generated', 'types.ts'), 'utf8');
  assert.match(types, /'semimonthly'/);
});

test('generated contract keeps legacy genericBudgetTarget alias and nested genericBudget', () => {
  const types = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'api', 'generated', 'types.ts'), 'utf8');
  assert.match(types, /genericBudgetTarget: number \| null;/);
  assert.match(types, /\/\*\* @deprecated Use assumptions\.genericBudget\.target \*\//);
  assert.match(types, /genericBudget: \{/);
});

test('generated contract includes transfer identity completeness types', () => {
  const types = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'api', 'generated', 'types.ts'), 'utf8');
  assert.match(types, /export interface ProjectionCompleteness/);
  assert.match(types, /transferIdentityUnresolvedCount: number/);
  assert.match(types, /'transfer_identity'/);
  assert.match(types, /transferReason\?: string/);
  assert.match(types, /knownSpendSubtotal\?: number/);
  assert.match(types, /totalSpend: number \| null/);
});

test('app and web gate spending and trends on projection completeness', () => {
  const types = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'api', 'generated', 'types.ts'), 'utf8');
  assert.match(types, /completeness: ProjectionCompleteness/);

  assert.match(browser, /current\?\.completeness\?\.complete !== false/);
  assert.match(browser, /monthTrendComplete/);
  assert.doesNotMatch(browser, /m\.income \?\? 0/);

  const spending = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'app', '(tabs)', 'spending.tsx'), 'utf8');
  const home = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'app', '(tabs)', 'index.tsx'), 'utf8');
  const cashflow = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'app', 'cashflow.tsx'), 'utf8');
  const review = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'app', 'review.tsx'), 'utf8');

  assert.match(spending, /spendingComplete = cur\?\.completeness\?\.complete !== false/);
  assert.match(spending, /'Unavailable'/);
  assert.match(home, /spendingComplete = cur\?\.completeness\?\.complete !== false/);
  assert.match(cashflow, /monthComplete\(m\)/);
  assert.match(review, /transfer_identity/);
});

test('generated contract includes obligation graph reservation types', () => {
  const types = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'api', 'generated', 'types.ts'), 'utf8');
  assert.match(types, /export interface ObligationGraphView/);
  assert.match(types, /obligation-graph/);
  assert.match(types, /obligationGraph\?:/);
});

test('app and web render reserved obligations from graph', () => {
  assert.match(appHome, /Cash Reserved/);
  assert.match(appHome, /obligations\.reserved/);
  assert.match(browser, /safeToSpendReserved/);
});

test('app and web render incomplete Safe-to-Spend as unavailable, never zero', () => {
  assert.match(browser, /Safe to Spend/);
  assert.match(browser, /metric\?\.complete === true && Number\.isFinite\(metric\.value\)/);
  assert.match(browser, /available \? fmt\(metric\.value\) : 'Unavailable'/);
  assert.doesNotMatch(browser, /fmt\(metric\.value\s*\|\|\s*0\)/);

  assert.match(appHome, /safeToSpend\?\.complete && safeToSpend\.value != null/);
  assert.match(appHome, /Safe to Spend unavailable/);
  assert.doesNotMatch(appHome, /fmtMoney\(safeToSpend\.value\s*\|\|\s*0\)/);
});

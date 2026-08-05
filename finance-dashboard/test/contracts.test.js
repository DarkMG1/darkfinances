const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
const generated = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'api', 'generated', 'endpoints.ts'), 'utf8');
const { listModuleFiles } = require('../lib/browser-static');
const dashboardRoot = path.resolve(__dirname, '..');
const browser = fs.readFileSync(path.join(dashboardRoot, 'public', 'index.html'), 'utf8');
const browserSources = [
  browser,
  ...listModuleFiles().map((file) => fs.readFileSync(path.join(dashboardRoot, 'public', 'js', file), 'utf8')),
].join('\n');
const appHome = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'app', '(tabs)', 'index.tsx'), 'utf8');
const appReimbursement = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'app', 'reimbursement.tsx'), 'utf8');
const generatedTypes = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'api', 'generated', 'types.ts'), 'utf8');

function serverRoutes() {
  const direct = [...server.matchAll(/\bv1\.(get|post|delete|put|patch)\('([^']+)'/g)]
    .map((match) => `${match[1].toUpperCase()} /api/v1${match[2]}`);
  const journaled = [...server.matchAll(/\bregisterV1Mutation\('([A-Z]+)', '([^']+)'/g)]
    .map((match) => `${match[1]} /api/v1${match[2]}`);
  return [...new Set([...direct, ...journaled])]
    .filter((route) => !route.includes('/test/'))
    .sort();
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

test('generated contract includes content-bound review task fields', () => {
  const types = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'api', 'generated', 'types.ts'), 'utf8');
  assert.match(types, /stableKey: string;/);
  assert.match(types, /contentHash: string;/);
  assert.match(types, /contentVersion: number;/);
});

test('generated contract describes bounded list metadata and optional receipt OCR', () => {
  assert.match(generatedTypes, /export interface OffsetPagination/);
  assert.match(generatedTypes, /nextOffset: number \| null;/);
  assert.match(generatedTypes, /export interface Receipts[\s\S]*pagination: OffsetPagination;/);
  assert.match(generatedTypes, /export interface Receipts[\s\S]*ocrIncluded: boolean;/);
  assert.match(generatedTypes, /ocrText\?: string;/);
  assert.match(generatedTypes, /ocrLines\?: string\[\];/);
  assert.match(generatedTypes, /export interface Rules[\s\S]*pagination: OffsetPagination;/);
  assert.match(generatedTypes, /export interface EventsResponse[\s\S]*pagination: OffsetPagination;/);
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

  assert.match(browserSources, /data\.completeness\?\.complete === true/);
  assert.match(browserSources, /comparisonCompleteness\?\.complete === true/);
  assert.match(browserSources, /monthTrendComplete/);
  assert.doesNotMatch(browserSources, /m\.income \?\? 0/);

  const spending = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'app', '(tabs)', 'spending.tsx'), 'utf8');
  const home = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'app', '(tabs)', 'index.tsx'), 'utf8');
  const cashflow = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'app', 'cashflow.tsx'), 'utf8');
  const review = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'app', 'review.tsx'), 'utf8');

  assert.match(spending, /spendingComplete = \(useCurrentToday[\s\S]*spending\.data\?\.completeness\?\.complete\) === true/);
  assert.match(spending, /'Unavailable'/);
  assert.match(home, /spendingComplete = today\.data\?\.spending\?\.completeness\?\.complete === true/);
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
  assert.match(appHome, /obligations\?\.reserved/);
  assert.match(browser, /safeToSpendReserved/);
});

test('app and web render incomplete Safe-to-Spend as unavailable, never zero', () => {
  assert.match(browser, /Safe to Spend/);
  assert.match(browserSources, /metric\?\.complete === true && Number\.isFinite\(metric\.value\)/);
  assert.match(browserSources, /available \? fmt\(metric\.value\) : 'Unavailable'/);
  assert.doesNotMatch(browserSources, /fmt\(metric\.value\s*\|\|\s*0\)/);
  assert.match(browser, /safeToSpendReasons/);
  assert.match(browserSources, /metric\?\.incompleteReasons/);
  assert.match(browser, /role="status"/);
  assert.match(browser, /aria-live="polite"/);

  assert.match(appHome, /safeToSpend\?\.complete && safeToSpend\.value != null/);
  assert.match(appHome, /Safe to Spend unavailable/);
  assert.match(appHome, /safeToSpend\?\.incompleteReasons/);
  assert.doesNotMatch(appHome, /fmtMoney\(safeToSpend\.value\s*\|\|\s*0\)/);
});

test('legacy web reimbursement renders MetricValue totals without NaN or fabricated zero', () => {
  assert.match(browserSources, /function renderMetricPos\(/);
  assert.match(browserSources, /metric\?\.complete === true && Number\.isFinite\(metric\.value\)/);
  assert.match(browserSources, /renderMetricPos\(data\.totalOwed\)/);
  assert.doesNotMatch(browserSources, /fmtPos\(data\.totalOwed\)/);
  assert.match(browserSources, /return fallback;/);

  assert.match(appReimbursement, /totalOwedMetric\?\.complete && isKnownMoney\(totalOwedMetric\.value\)/);
  assert.doesNotMatch(appReimbursement, /totalOwedMetric\.value \?\? 0/);
  assert.match(appReimbursement, /formatOptionalPos\(netValue, fmtPos\)/);
  assert.match(appReimbursement, /grandLowerBound != null \?/);
});

test('generated contract includes account projection metric and inclusion types', () => {
  assert.match(generatedTypes, /inclusion\?: \{/);
  assert.match(generatedTypes, /metrics\?: \{/);
  assert.match(generatedTypes, /netWorth: MetricValue/);
  assert.match(generatedTypes, /accountProjectionRevision\?: string/);
  assert.match(generatedTypes, /netWorthIncludedAccountIds\?: string\[\]/);
});

test('generated contract includes manual asset revision and spending comparison completeness', () => {
  assert.match(generatedTypes, /manualAssetsRevision\?: string/);
  assert.match(generatedTypes, /comparisonCompleteness\?: ProjectionCompleteness/);
});

test('clients prefer authoritative server net worth and withhold local fallback when server metric is incomplete', () => {
  const home = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'app', '(tabs)', 'index.tsx'), 'utf8');
  const networth = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'app', 'networth.tsx'), 'utf8');
  const widget = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'components', 'widget-sync.tsx'), 'utf8');
  assert.match(home, /resolveNetWorthAggregateDisplay/);
  assert.match(networth, /resolveNetWorthAggregateDisplay/);
  assert.match(home, /comparisonComplete = today\.data\?\.spending\?\.comparisonCompleteness\?\.complete === true/);
  assert.match(home, /this month · synced accounts only/);
  assert.match(networth, /this month · synced accounts only/);
  assert.match(widget, /resolveWidgetNetWorthDecision/);
  assert.match(widget, /clearFinanceWidget/);
  assert.match(browserSources, /aggregatesUnavailable/);
  assert.match(browserSources, /inclusion\?\.netWorth/);
});

test('generated contract includes splitwise mirror identity and manual asset completeness', () => {
  assert.match(generatedTypes, /export interface SplitwiseMirrorIdentity/);
  assert.match(generatedTypes, /splitwiseMirrorIdentity\?: SplitwiseMirrorIdentity/);
  assert.match(generatedTypes, /complete\?: boolean;/);
});

test('server account override invalidation includes insights', () => {
  const server = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /'accounts', 'today', 'forecast', 'trends', 'spending', 'goals', 'review', 'reports', 'insights'/);
});

test('generated contract includes goal feasibility and advisory types', () => {
  assert.match(generatedTypes, /export interface GoalFeasibility/);
  assert.match(generatedTypes, /export interface GoalAdvisory/);
  assert.match(generatedTypes, /goalAdvisory\?: GoalAdvisory/);
  assert.match(generatedTypes, /rolloverConfigured: boolean/);
  assert.match(generatedTypes, /resolved: boolean/);
  assert.match(generatedTypes, /reserveCents: number \| null/);
  assert.doesNotMatch(generatedTypes, /export interface GoalsResponse/);
});

test('app surfaces advisory goal feasibility without fabricating Safe-to-Spend', () => {
  const goals = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'app', 'goals.tsx'), 'utf8');
  assert.match(goals, /feasibility\?\.overAllocated/);
  assert.match(goals, /renderContent=\{\(goalList\)/);
  assert.match(goals, /\(goalList \?\? \[\]\)\.map/);
  assert.match(appHome, /goalAdvisory/);
  assert.match(appHome, /does not reduce Safe to Spend/);
});

test('budgets screen fails closed on unresolved reserve and nullable envelope debt', () => {
  const budgets = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'app', 'budgets.tsx'), 'utf8');
  assert.match(budgets, /categoryReserveDisplay/);
  assert.match(budgets, /categoryEnvelopeDebtDisplay/);
  assert.match(budgets, /reserve unavailable/);
  assert.match(budgets, /Rollover policy unresolved/);
  assert.doesNotMatch(budgets, /c\.reserve \?\? c\.remaining/);
  assert.doesNotMatch(budgets, /c\.envelopeDebt > 0/);
  assert.match(generatedTypes, /envelopeDebt: number \| null/);
});

test('generated contract exposes report trend completeness and nullable monthly review totals', () => {
  assert.match(generatedTypes, /categoryTrendsComplete\?: boolean/);
  assert.match(generatedTypes, /merchantTrendsComplete\?: boolean/);
  assert.match(generatedTypes, /merchantTrendsTruncated\?: boolean/);
  assert.match(generatedTypes, /monthlyReview:[\s\S]*income: number \| null/);
  assert.match(generatedTypes, /monthlyReview:[\s\S]*knownSpendSubtotal\?: number/);
});

test('forecast screen labels partial ending balance and renders all warnings when projection containment is incomplete', () => {
  const forecast = fs.readFileSync(path.resolve(__dirname, '..', '..', 'finance-app', 'src', 'app', 'forecast.tsx'), 'utf8');
  assert.match(forecast, /projectionContainment\?\.complete === false/);
  assert.match(forecast, /Partial projection/);
  assert.match(forecast, /(?:data|forecastData)\.warnings(?:\?\.|\.)map|warnings\.map/);
  assert.doesNotMatch(forecast, /(?:data|forecastData)\.warnings\[0\]/);
  assert.match(forecast, /Projection containment is incomplete/);
});

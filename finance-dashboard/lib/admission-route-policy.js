'use strict';

const { todayYMD } = require('./date-only');

function normalizeApiPath(req) {
  const raw = req.path || '/';
  return raw.replace(/^\/api(?:\/v1)?(?=\/|$)/i, '') || '/';
}

function endpointId(method, path) {
  return `${String(method || 'GET').toUpperCase()} ${String(path || '/').replace(/\/+$/, '') || '/'}`.toLowerCase();
}

function monthOf(req) {
  return req.query?.month;
}

function actualCacheKeyForRead(req) {
  const path = normalizeApiPath(req);
  const today = todayYMD();
  if (path === '/accounts') return 'accounts';
  if (path === '/today') return 'today';
  if (path === '/categories') return 'categories';
  if (path === '/goals') return 'goals';
  if (path === '/tags') return 'tags';
  if (path === '/events') return 'events';
  if (path === '/budgets') {
    return `budgets-${monthOf(req) || 'current'}`;
  }
  if (path === '/review') {
    return `review-${monthOf(req) || 'current'}`;
  }
  if (path === '/insights') {
    return `insights-${monthOf(req) || 'current'}`;
  }
  if (path === '/reports') {
    return `reports-${monthOf(req) || 'current'}`;
  }
  if (path === '/transactions') {
    const { accountId, start, end, category, bucket } = req.query || {};
    const budgetOnly = req.query?.budgetOnly === '1' || req.query?.budgetOnly === 'true';
    const collapse = req.query?.collapse === '1' || req.query?.collapse === 'true';
    const startDate = start || `${today.slice(0, 7)}-01`;
    const endDate = end || today;
    return `txns-${accountId || 'all'}-${startDate}-${endDate}-${category || 'all'}-${bucket || 'none'}-${budgetOnly ? 'budget' : 'all'}-${collapse ? 'c' : 'x'}`;
  }
  if (/^\/transactions\/[^/]+$/i.test(path)) return null;
  if (path === '/merchant-history') {
    const { payee, months } = req.query || {};
    return `mhist-${(payee || '').toLowerCase()}-${months || 12}`;
  }
  if (path === '/spending') {
    const start = req.query?.start ? String(req.query.start) : undefined;
    const end = req.query?.end ? String(req.query.end) : undefined;
    return start && end ? `spending-${start}-${end}` : `spending-${monthOf(req) || 'current'}`;
  }
  if (path === '/trends') {
    const months = Math.min(60, Math.max(3, parseInt(req.query?.months, 10) || 12));
    return `trends-${months}`;
  }
  if (path === '/reimbursement') {
    const { from, to } = req.query || {};
    const openOnly = req.query?.openOnly === '1' || req.query?.openOnly === 'true';
    return `reimb-${from || 'd'}-${to || 'd'}-${openOnly}`;
  }
  if (path === '/reimbursement-ledger') {
    return `reimb-ledger-${monthOf(req) || 'current'}`;
  }
  if (path === '/repayments/suggestions') {
    const { from, to } = req.query || {};
    return `reimb-suggest-${from || 'd'}-${to || 'd'}`;
  }
  if (path === '/recurring') {
    const window = Math.min(36, Math.max(6, parseInt(req.query?.window, 10) || 18));
    if (req.query?.debug === '1') return null;
    return `recurring-${window}`;
  }
  if (path === '/bills') {
    const days = Math.min(120, Math.max(7, parseInt(req.query?.days, 10) || 45));
    return `bills-${days}`;
  }
  if (path === '/forecast') {
    const days = Math.min(180, Math.max(30, parseInt(req.query?.days, 10) || 90));
    return `forecast-${days}`;
  }
  if (path === '/income') {
    const window = Math.min(24, Math.max(6, parseInt(req.query?.window, 10) || 12));
    return `income-${window}`;
  }
  if (path === '/search') {
    const q = (req.query?.q || '').toString();
    const limit = Math.min(500, Math.max(1, parseInt(req.query?.limit, 10) || 200));
    const { start, end } = req.query || {};
    return `search-${q}-${start || ''}-${end || ''}-${limit}`;
  }
  return null;
}

function classifyReadRoute(req) {
  const method = req.method;
  const path = normalizeApiPath(req);
  const endpoint = endpointId(method, path);

  if (method === 'GET' && /^\/operations\/[^/]+$/i.test(path)) {
    return { lane: 'read', endpoint, policy: 'control', weight: 1, cacheKey: null };
  }
  if (method === 'GET' && path === '/ping') {
    return { lane: 'read', endpoint, policy: 'control', weight: 1, cacheKey: null };
  }
  if (method === 'GET' && path === '/reconnect-freshness') {
    return { lane: 'read', endpoint, policy: 'control', weight: 1, cacheKey: null };
  }
  if (method === 'GET' && (path === '/reconciliation' || path === '/reconciliation/pending')) {
    return { lane: 'read', endpoint, policy: 'actual-direct', weight: 2, cacheKey: null };
  }
  if (method === 'GET' && /^\/transactions\/[^/]+$/i.test(path)) {
    return { lane: 'read', endpoint, policy: 'actual-direct', weight: 2, cacheKey: null };
  }
  if (method === 'GET' && path === '/report.csv') {
    return { lane: 'read', endpoint, policy: 'actual-direct', weight: 2, cacheKey: null };
  }
  if (method === 'GET' && path === '/reimbursement-export') {
    return { lane: 'read', endpoint, policy: 'actual-direct', weight: 2, cacheKey: null };
  }
  if (method === 'GET' && (path === '/rules' || path === '/manual-assets' || path === '/investments')) {
    return { lane: 'none', endpoint, policy: 'local', weight: 0, cacheKey: null };
  }
  if (method === 'GET' && (
    path === '/phantom/log'
    || path === '/reimb-links'
    || path === '/owes-config'
  )) {
    return { lane: 'none', endpoint, policy: 'local-sidecar', weight: 0, cacheKey: null };
  }
  if (method === 'GET' && /^\/receipts\/[^/]+\/image$/i.test(path)) {
    return { lane: 'lightweight', endpoint, policy: 'lightweight-disk', weight: 1, cacheKey: null };
  }
  const cacheKey = actualCacheKeyForRead(req);
  if (cacheKey) {
    return { lane: 'read', endpoint, policy: 'actual-cached', weight: 1, cacheKey };
  }
  if (method === 'GET') {
    return { lane: 'read', endpoint, policy: 'actual-direct', weight: 1, cacheKey: null };
  }
  return { lane: 'none', endpoint, policy: 'free', weight: 0, cacheKey: null };
}

function classifyMutationRoute(req) {
  const path = normalizeApiPath(req);
  return {
    lane: 'mutation',
    endpoint: endpointId(req.method, path),
    policy: 'mutation',
    weight: 1,
    cacheKey: null,
  };
}

module.exports = {
  actualCacheKeyForRead,
  classifyMutationRoute,
  classifyReadRoute,
  endpointId,
  normalizeApiPath,
};

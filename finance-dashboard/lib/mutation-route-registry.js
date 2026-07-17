const CLASSIFICATIONS = Object.freeze({
  PRE_WRITE_VALIDATION_ONLY: 'pre_write_validation_only',
  SIDECAR_LOCAL: 'sidecar_local',
  ACTUAL_LOCAL_THEN_SYNC: 'actual_local_then_sync',
  MULTIPLE_INTERNAL_WRITES: 'multiple_internal_writes',
});

const C = CLASSIFICATIONS;

const MUTATION_ROUTES = Object.freeze([
  route('POST', '/transactions', C.MULTIPLE_INTERNAL_WRITES, 'api.createPayee (when needed) or api.addTransactions', 'after_local'),
  route('POST', '/budgets', C.MULTIPLE_INTERNAL_WRITES, 'api.setBudgetAmount before optional budget-settings write', 'after_local'),
  route('POST', '/review/dispositions', C.SIDECAR_LOCAL, 'atomic review-state JSON write'),
  route('POST', '/transactions/:id/category', C.MULTIPLE_INTERNAL_WRITES, 'api.updateTransaction, or prepared replacement-saga write for a split leg', 'after_local'),
  route('POST', '/transactions/:id/notes', C.MULTIPLE_INTERNAL_WRITES, 'api.updateTransaction, or prepared replacement-saga write for a split leg', 'after_local'),
  route('POST', '/transactions/:id/date', C.ACTUAL_LOCAL_THEN_SYNC, 'api.updateTransaction', 'after_local'),
  route('POST', '/transactions/:id/payee', C.MULTIPLE_INTERNAL_WRITES, 'api.createPayee (when needed), api.updateTransaction, or prepared replacement-saga write', 'after_local'),
  route('POST', '/transactions/:id/split', C.MULTIPLE_INTERNAL_WRITES, 'api.createPayee (when needed) or prepared replacement-saga write', 'after_local'),
  route('POST', '/transactions/:id/unsplit', C.MULTIPLE_INTERNAL_WRITES, 'prepared replacement-saga write before Actual delete/add', 'after_local'),
  route('DELETE', '/transactions/:id', C.MULTIPLE_INTERNAL_WRITES, 'prepared deletion-saga write before Actual delete and exact reference cleanup', 'after_local'),
  route('POST', '/bank-sync', C.MULTIPLE_INTERNAL_WRITES, 'api.runBankSync', 'after_local'),
  route('POST', '/reimbursements/sweep', C.MULTIPLE_INTERNAL_WRITES, 'first matching Actual update or prepared replacement-saga write', 'after_local'),
  route('POST', '/phantom/cleanup', C.MULTIPLE_INTERNAL_WRITES, 'first bulk item pending checkpoint or prepared deletion-saga write; dry-run has no write', 'after_local'),
  route('POST', '/receipts', C.MULTIPLE_INTERNAL_WRITES, 'receipt image rename before receipt metadata write'),
  route('DELETE', '/receipts/:id', C.MULTIPLE_INTERNAL_WRITES, 'receipt image rename before receipt metadata write'),
  route('POST', '/rules', C.MULTIPLE_INTERNAL_WRITES, 'first bulk item pending checkpoint, or rules sidecar write when no match', 'after_local_if_changed'),
  route('POST', '/rules/apply', C.MULTIPLE_INTERNAL_WRITES, 'first bulk item pending checkpoint across rule/catalog/settle-up stages', 'after_local_if_changed'),
  route('DELETE', '/rules/:id', C.SIDECAR_LOCAL, 'atomic rules JSON write'),
  route('POST', '/splitwise/sync-shares', C.MULTIPLE_INTERNAL_WRITES, 'Actual account/category creation or first transaction add/update/delete', 'after_local'),
  route('POST', '/events', C.SIDECAR_LOCAL, 'atomic events JSON write'),
  route('DELETE', '/events/:slug', C.SIDECAR_LOCAL, 'atomic events JSON write'),
  route('POST', '/accounts/:id/override', C.SIDECAR_LOCAL, 'atomic account-overrides JSON write'),
  route('POST', '/manual-assets', C.SIDECAR_LOCAL, 'atomic manual-assets JSON write'),
  route('DELETE', '/manual-assets/:id', C.SIDECAR_LOCAL, 'atomic manual-assets JSON write'),
  route('POST', '/recurring/:key/override', C.SIDECAR_LOCAL, 'atomic recurring-overrides JSON write'),
  route('POST', '/recurring/mark', C.SIDECAR_LOCAL, 'atomic recurring-overrides JSON write'),
  route('POST', '/bills/paid', C.SIDECAR_LOCAL, 'atomic bills-paid JSON write'),
  route('POST', '/owes-config', C.SIDECAR_LOCAL, 'atomic owes-config JSON write'),
  route('POST', '/reimb-links', C.SIDECAR_LOCAL, 'atomic reimbursement-links JSON write'),
  route('DELETE', '/reimb-links', C.SIDECAR_LOCAL, 'atomic reimbursement-links JSON write when a link exists'),
  route('POST', '/repayments/:id/confirm', C.MULTIPLE_INTERNAL_WRITES, 'prepared repayment-confirmation saga write before category update, reimbursement-link writes, and suggestion audit', 'after_local'),
  route('POST', '/repayments/:id/dismiss', C.SIDECAR_LOCAL, 'atomic reimbursement-suggestions JSON write'),
  route('POST', '/reconciliation/item', C.SIDECAR_LOCAL, 'atomic reconciliation JSON write'),
  route('POST', '/reconciliation/month', C.SIDECAR_LOCAL, 'atomic reconciliation JSON write'),
  route('POST', '/reconciliation/enabled', C.SIDECAR_LOCAL, 'atomic reconciliation JSON write'),
  route('POST', '/goals', C.SIDECAR_LOCAL, 'atomic goals JSON write after read-only Actual capacity checks'),
  route('DELETE', '/goals/:id', C.SIDECAR_LOCAL, 'atomic goals JSON write'),
  route('POST', '/refresh', C.PRE_WRITE_VALIDATION_ONLY, 'no domain write; Actual synchronization refreshes the local cache', 'after_noop_checkpoint'),
]);

function route(method, path, classification, firstEffect, synchronization = 'none') {
  return Object.freeze({
    method,
    path,
    classification,
    firstEffect,
    synchronization,
    requiresCheckpoint: true,
  });
}

function routeKey(method, path) {
  return `${String(method).toUpperCase()} ${path}`;
}

const ROUTES_BY_KEY = new Map(MUTATION_ROUTES.map((definition) => [
  routeKey(definition.method, definition.path),
  definition,
]));

function getMutationRoute(method, path) {
  return ROUTES_BY_KEY.get(routeKey(method, path)) || null;
}

module.exports = {
  CLASSIFICATIONS,
  MUTATION_ROUTES,
  getMutationRoute,
  routeKey,
};

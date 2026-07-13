const path = require('path');

const root = path.join(__dirname, '..');

const STATE_REGISTRY = Object.freeze({
  accountOverrides: entry('ACCOUNT_OVERRIDES_PATH', 'account-overrides.json', 2, true, 'account ids'),
  billsPaid: entry('BILLS_PAID_PATH', 'bills-paid.json', 1, true, 'recurring keys'),
  budgetSettings: entry('BUDGET_SETTINGS_PATH', 'budget-settings.json', 1, true, 'category ids'),
  debtPlanner: entry('DEBT_PLANNER_PATH', 'debt-planner.json', 1, true, null),
  events: entry('EVENTS_PATH', 'events.json', 1, true, 'event slugs and transaction ids'),
  goals: entry('GOALS_PATH', 'goals.json', 1, true, 'account ids'),
  investmentHoldings: entry('INVESTMENT_HOLDINGS_PATH', 'investment-holdings.json', 1, true, 'account ids'),
  manualAssets: entry('MANUAL_ASSETS_PATH', 'manual-assets.json', 1, true, null),
  operationJournal: entry('OPERATION_JOURNAL_PATH', 'operation-journal.json', 1, true, 'idempotency keys'),
  owesConfig: entry('OWES_CONFIG_PATH', 'owes-config.json', 1, true, 'person identities'),
  owesTruth: entry('OWES_TRUTH_PATH', 'owes-truth.json', 2, true, 'Splitwise pairwise identities'),
  personalConfig: entry('PERSONAL_CONFIG_PATH', 'personal-config.json', 1, true, null),
  phantomLog: entry('PHANTOM_LOG_PATH', 'phantom-log.json', 1, true, 'transaction imported ids'),
  phantomSeen: entry('PHANTOM_SEEN_PATH', 'phantom-seen.json', 1, true, 'transaction imported ids'),
  receipts: entry('RECEIPTS_PATH', 'receipts.json', 1, true, 'transaction ids and receipt files'),
  reimbursementLinks: entry('REIMB_LINKS_PATH', 'reimb-links.json', 1, true, 'transaction ids'),
  reimbursementSuggestions: entry('REIMB_SUGGEST_PATH', 'reimb-suggest.json', 1, true, 'transaction ids'),
  reconciliation: entry('RECON_PATH', 'reconciliation.json', 1, true, 'transaction ids'),
  recurringOverrides: entry('RECURRING_OVERRIDES_PATH', 'recurring-overrides.json', 1, true, 'recurring keys'),
  reviewState: entry('REVIEW_STATE_PATH', 'review-state.json', 1, true, 'stable review fingerprints'),
  rules: entry('RULES_PATH', 'rules.json', 1, true, 'rule ids'),
  transactionSagas: entry('TRANSACTION_SAGAS_PATH', 'transaction-sagas.json', 1, true, 'Actual and sidecar transaction ids'),
  venmoTruth: entry('VENMO_TRUTH_PATH', 'venmo-truth.json', 1, true, 'Venmo transaction ids'),
});

function entry(env, filename, schemaVersion, backup, references) {
  return Object.freeze({
    env,
    filename,
    schemaVersion,
    durability: 'atomic-json-last-good',
    backup,
    references,
  });
}

function statePath(name, env = process.env) {
  const definition = STATE_REGISTRY[name];
  if (!definition) throw new Error(`Unknown runtime state: ${name}`);
  return env[definition.env] || path.join(root, definition.filename);
}

function backupEntries(env = process.env) {
  return Object.entries(STATE_REGISTRY)
    .filter(([, definition]) => definition.backup)
    .map(([name, definition]) => ({
      name,
      ...definition,
      path: statePath(name, env),
    }));
}

module.exports = {
  STATE_REGISTRY,
  backupEntries,
  statePath,
};

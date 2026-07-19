/**
 * Per-screen query display contracts for compound refetch wiring and inventory tests.
 */

/** Standard primary read gate order on list/detail screens. */
const PRIMARY_QUERY_GATE_ORDER = ['initialLoad', 'fatalError', 'refetchBanner', 'content'];

/**
 * @param {{ today: unknown; trends: unknown; manual: unknown; recurring: unknown; widgets: { netWorth: boolean; subscriptions: boolean } }} ctx
 */
function buildHomeRefetchQueries(ctx) {
  return [
    ctx.today,
    ...(ctx.widgets.netWorth ? [ctx.trends, ctx.manual] : []),
    ...(ctx.widgets.subscriptions ? [ctx.recurring] : []),
  ];
}

/**
 * @param {{ spendingQuery: unknown; trends: unknown; budgets: unknown; reimb: unknown; insights: unknown; tags: unknown }} ctx
 */
function buildSpendingRefetchQueries(ctx) {
  return [ctx.spendingQuery, ctx.trends, ctx.budgets, ctx.reimb, ctx.insights, ctx.tags];
}

/**
 * @param {{ listQuery: unknown; accounts: unknown; categories: unknown; events: unknown; groupEvents: boolean; searching: boolean }} ctx
 */
function buildActivityRefetchQueries(ctx) {
  return [
    ctx.listQuery,
    ctx.accounts,
    ctx.categories,
    { query: ctx.events, enabled: ctx.groupEvents && !ctx.searching },
  ];
}

/** @param {{ goals: unknown; accounts: unknown }} ctx */
function buildGoalsRefetchQueries(ctx) {
  return [ctx.goals, ctx.accounts];
}

/** @param {{ rules: unknown; categories: unknown }} ctx */
function buildRulesRefetchQueries(ctx) {
  return [ctx.rules, ctx.categories];
}

/** @param {{ budgets: unknown; trends: unknown }} ctx */
function buildBudgetsRefetchQueries(ctx) {
  return [ctx.budgets, ctx.trends];
}

/** @param {{ accounts: unknown; today: unknown; trends: unknown; manual: unknown }} ctx */
function buildNetworthRefetchQueries(ctx) {
  return [ctx.accounts, ctx.today, ctx.trends, ctx.manual];
}

/** @param {{ reimb: unknown; suggestions: unknown }} ctx */
function buildReimbursementRefetchQueries(ctx) {
  return [ctx.reimb, ctx.suggestions];
}

/** @param {{ accounts: unknown; categories: unknown }} ctx */
function buildAddTransactionRefetchQueries(ctx) {
  return [ctx.accounts, ctx.categories];
}

const COMPOUND_SCREEN_QUERY_CONTRACTS = {
  home: {
    file: 'src/app/(tabs)/index.tsx',
    primaryQuery: 'today',
    gateOrder: PRIMARY_QUERY_GATE_ORDER,
    buildRefetchQueries: buildHomeRefetchQueries,
    refetchMemberKeys: ['today', 'trends', 'manual', 'recurring'],
    enableConditions: {
      trends: 'widgets.netWorth',
      manual: 'widgets.netWorth',
      recurring: 'widgets.subscriptions',
    },
  },
  spending: {
    file: 'src/app/(tabs)/spending.tsx',
    primaryQuery: 'spendingQuery',
    gateOrder: PRIMARY_QUERY_GATE_ORDER,
    buildRefetchQueries: buildSpendingRefetchQueries,
    refetchMemberKeys: ['spendingQuery', 'trends', 'budgets', 'reimb', 'insights', 'tags'],
    enableConditions: {},
  },
  activity: {
    file: 'src/app/(tabs)/transactions.tsx',
    primaryQuery: 'listQuery',
    gateOrder: PRIMARY_QUERY_GATE_ORDER,
    buildRefetchQueries: buildActivityRefetchQueries,
    refetchMemberKeys: ['listQuery', 'accounts', 'categories', 'events'],
    enableConditions: {
      events: 'groupEvents && !searching',
    },
  },
  goals: {
    file: 'src/app/goals.tsx',
    primaryQuery: 'goals',
    gateOrder: PRIMARY_QUERY_GATE_ORDER,
    buildRefetchQueries: buildGoalsRefetchQueries,
    refetchMemberKeys: ['goals', 'accounts'],
    enableConditions: {},
  },
  rules: {
    file: 'src/app/rules.tsx',
    primaryQuery: 'rules',
    gateOrder: PRIMARY_QUERY_GATE_ORDER,
    buildRefetchQueries: buildRulesRefetchQueries,
    refetchMemberKeys: ['rules', 'categories'],
    enableConditions: {},
  },
  budgets: {
    file: 'src/app/budgets.tsx',
    primaryQuery: 'budgets',
    gateOrder: PRIMARY_QUERY_GATE_ORDER,
    buildRefetchQueries: buildBudgetsRefetchQueries,
    refetchMemberKeys: ['budgets', 'trends'],
    enableConditions: {},
  },
  networth: {
    file: 'src/app/networth.tsx',
    primaryQuery: 'accounts',
    gateOrder: PRIMARY_QUERY_GATE_ORDER,
    buildRefetchQueries: buildNetworthRefetchQueries,
    refetchMemberKeys: ['accounts', 'today', 'trends', 'manual'],
    enableConditions: {},
  },
  reimbursement: {
    file: 'src/app/reimbursement.tsx',
    primaryQuery: 'reimb',
    gateOrder: PRIMARY_QUERY_GATE_ORDER,
    buildRefetchQueries: buildReimbursementRefetchQueries,
    refetchMemberKeys: ['reimb', 'suggestions'],
    enableConditions: {},
  },
  addTransaction: {
    file: 'src/app/add-transaction.tsx',
    primaryQuery: 'accounts',
    gateOrder: ['initialLoad', 'fatalError', 'refetchBanner', 'content'],
    buildRefetchQueries: buildAddTransactionRefetchQueries,
    refetchMemberKeys: ['accounts', 'categories'],
    enableConditions: {},
    categoriesOptional: true,
  },
};

module.exports = {
  PRIMARY_QUERY_GATE_ORDER,
  buildHomeRefetchQueries,
  buildSpendingRefetchQueries,
  buildActivityRefetchQueries,
  buildGoalsRefetchQueries,
  buildRulesRefetchQueries,
  buildBudgetsRefetchQueries,
  buildNetworthRefetchQueries,
  buildReimbursementRefetchQueries,
  buildAddTransactionRefetchQueries,
  COMPOUND_SCREEN_QUERY_CONTRACTS,
};

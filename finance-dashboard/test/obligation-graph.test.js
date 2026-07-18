'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OBLIGATION_GRAPH_VERSION,
  OBLIGATION_REASON,
  OCCURRENCE_ROLE,
  buildObligationGraph,
  forecastCashEventsFromGraph,
  graphCompleteness,
  safeToSpendFromGraph,
  verifyGraphInvariants,
  stableOccurrenceId,
} = require('../lib/domain/obligation-graph');
const {
  assembleObligationGraphInputs,
  billDurableIdentity,
  buildGraphTransactionInputs,
  recurringDurableIdentity,
} = require('../lib/obligation-graph-bridge');
const { sumCents } = require('../lib/domain/money');
const { projectOccurrences, inferRecurrenceSchedule } = require('../lib/recurrence');
const { addDays, monthEnd } = require('../lib/date-only');

const TODAY = '2026-07-17';
const WINDOW_END = '2026-10-17';

function buildGraph(overrides = {}) {
  const input = assembleObligationGraphInputs({
    financeDate: TODAY,
    windowStart: TODAY,
    windowEnd: WINDOW_END,
    accounts: overrides.accounts || [{
      id: 'checking', name: 'Checking', role: 'operating_cash', balance: 5000, closed: false, hidden: false,
    }],
    recurring: overrides.recurring || { items: [], hiddenItems: [] },
    income: overrides.income || { streams: [] },
    bills: overrides.bills || { bills: [] },
    budgets: overrides.budgets || {
      supported: true,
      groups: [{
        name: 'Everyday',
        categories: [{ id: 'groceries', name: 'Groceries', remaining: 100 }],
      }],
    },
    debts: overrides.debts || [],
    reimb: overrides.reimb || { totalOwed: 0 },
    reimbLinks: overrides.reimbLinks || [],
    operatingAccountIds: overrides.operatingAccountIds || ['checking'],
    ...overrides.inputExtras,
  });
  return buildObligationGraph({ ...input, ...overrides.graphExtras });
}

test('reproduction: legacy paths double-count bill+subscription monthly totals separately from bills list', () => {
  const recurringItems = [{
    key: 'netflix',
    payee: 'Netflix',
    status: 'active',
    isBill: true,
    cadence: 'monthly',
    amount: 15.99,
    forced: true,
    history: [{ date: '2026-05-17', amount: 15.99 }, { date: '2026-06-17', amount: 15.99 }],
  }];
  const subMonthly = recurringItems.filter((i) => !i.isBill).reduce((s, i) => s + i.amount, 0);
  const billMonthly = recurringItems.filter((i) => i.isBill).reduce((s, i) => s + i.amount, 0);
  const bothTotals = subMonthly + billMonthly;
  assert.equal(bothTotals, 15.99);
  const graph = buildGraph({
    recurring: { items: recurringItems },
    bills: { bills: [{ id: 'netflix|2026-08-17', key: 'netflix', payee: 'Netflix', dueDate: '2026-08-17', amount: 15.99, paid: false }] },
  });
  const reserved = graph.occurrences.filter((occ) => occ.reserved && occ.role === OCCURRENCE_ROLE.CASH_OUTFLOW
    && (occ.source?.kind === 'bill' || occ.dedupeGroup?.startsWith('bill-series:')));
  assert.equal(reserved.length, 1, 'graph reserves the bill occurrence exactly once');
});

test('credit purchase is economic-only; explicit current_balance policy reserves payment once', () => {
  const graph = buildObligationGraph({
    financeDate: TODAY,
    windowStart: TODAY,
    windowEnd: WINDOW_END,
    operatingAccountIds: ['checking'],
    fundingAccountsByLiability: { card: 'checking' },
    billCategoryIds: [],
    economicTransactions: [{
      durableIdentity: 'txn:purchase-1',
      transactionId: 'purchase-1',
      date: '2026-07-17',
      amountCents: -5000,
      label: 'Coffee',
      explanation: ['Credit card purchase — economic spend only'],
    }],
    creditLiabilities: [{
      durableIdentity: 'liability:credit:card',
      accountId: 'card',
      name: 'Card',
      eligible: true,
      obligationCents: 5000,
      currentBalanceCents: -5000,
      coverageKind: 'current_balance',
      paymentDueDate: '2026-08-01',
      paymentRecurringKey: 'card-pay',
      fundingAccountId: 'checking',
      cycleKey: 'liability-cycle:card:2026-08-01',
      quarantineReasons: [],
    }],
    recurringItems: [],
    billOccurrences: [],
    incomeStreams: [],
    manualDebts: [],
    transfers: [],
    budgetReservations: [],
    reimbursementExpectations: [],
  });
  const economic = graph.occurrences.filter((occ) => occ.role === OCCURRENCE_ROLE.ECONOMIC_EXPENSE || occ.auditOnly);
  const cash = graph.occurrences.filter((occ) => occ.reserved && occ.role === OCCURRENCE_ROLE.CASH_OUTFLOW);
  assert.equal(economic.length, 1);
  assert.equal(cash.length, 1);
  assert.equal(cash[0].amountCents, -5000);
});

test('installment debt conserves principal and interest components', () => {
  const graph = buildGraph({
    debts: [{
      id: 'car',
      name: 'Car loan',
      dueDate: '2026-08-05',
      minPayment: 350,
      balance: 12000,
      principalPortionCents: 30000,
      interestPortionCents: 5000,
    }],
  });
  const occ = graph.occurrences.find((item) => item.dedupeGroup === 'debt:car');
  assert.ok(occ);
  assert.equal(occ.amountCents, -35000);
  assert.deepEqual(occ.components, { principalCents: 30000, interestCents: 5000 });
});

test('recurring subscription plus bill duplicate collapses to one reservation', () => {
  const graph = buildGraph({
    recurring: {
      items: [{
        key: 'rentco',
        payee: 'RentCo',
        status: 'active',
        isBill: true,
        cadence: 'monthly',
        amount: 2100,
        forced: true,
        history: [{ date: '2026-05-01', amount: 2100 }, { date: '2026-06-01', amount: 2100 }],
      }],
    },
    bills: {
      bills: [{
        id: 'rentco|2026-08-01',
        key: 'rentco',
        payee: 'RentCo',
        dueDate: '2026-08-01',
        amount: 2100,
        paid: false,
      }],
    },
  });
  const reserved = graph.occurrences.filter((occ) => occ.reserved);
  const august = reserved.filter((occ) => occ.date === '2026-08-01');
  assert.equal(august.length, 1);
});

test('malformed transfer identity quarantines obligation graph', () => {
  const graph = buildObligationGraph({
    financeDate: TODAY,
    windowStart: TODAY,
    windowEnd: WINDOW_END,
    operatingAccountIds: ['checking'],
    transfers: [{
      durableIdentity: 'transfer:broken',
      linkId: 'broken',
      date: '2026-07-20',
      amountCents: -10000,
      fromAccountId: 'checking',
      toAccountId: 'missing',
      ambiguous: true,
    }],
    recurringItems: [],
    billOccurrences: [],
    incomeStreams: [],
    manualDebts: [],
    creditLiabilities: [],
    budgetReservations: [],
    reimbursementExpectations: [],
    economicTransactions: [],
  });
  assert.equal(graphCompleteness(graph).complete, false);
  assert.ok(graphCompleteness(graph).incompleteReasons.includes(OBLIGATION_REASON.transferAmbiguous));
});

test('one-sided Actual transfer in window stays complete without cash reservation', () => {
  const graph = buildObligationGraph({
    financeDate: TODAY,
    windowStart: TODAY,
    windowEnd: WINDOW_END,
    operatingAccountIds: ['checking'],
    transfers: [{
      durableIdentity: 'transfer:one-sided',
      linkId: 'one-sided',
      date: '2026-07-20',
      amountCents: -10000,
      fromAccountId: 'checking',
      toAccountId: null,
      ambiguous: false,
    }],
    recurringItems: [],
    billOccurrences: [],
    incomeStreams: [],
    manualDebts: [],
    creditLiabilities: [],
    budgetReservations: [],
    reimbursementExpectations: [],
    economicTransactions: [],
  });
  assert.equal(graphCompleteness(graph).complete, true);
  const internal = graph.occurrences.filter((occ) => occ.role === OCCURRENCE_ROLE.INTERNAL_TRANSFER);
  assert.equal(internal.length, 1);
  assert.ok(internal.every((occ) => !occ.reserved));
});

test('income streams project cash inflows without reserving Safe-to-Spend', () => {
  const graph = buildGraph({
    income: {
      streams: [{
        key: 'salary',
        payee: 'Employer',
        active: true,
        cadence: 'semimonthly',
        amount: 2500,
        lastPaid: '2026-07-01',
        history: [{ date: '2026-06-15', amount: 2500 }, { date: '2026-07-01', amount: 2500 }],
      }],
    },
  });
  const inflows = graph.occurrences.filter((occ) => occ.role === OCCURRENCE_ROLE.CASH_INFLOW);
  assert.ok(inflows.length >= 1);
  assert.ok(inflows.every((occ) => !occ.reserved));
});

test('Splitwise reimbursement partial/ambiguous quarantines graph completeness', () => {
  const ambiguous = buildGraph({ reimbLinks: [{ ambiguous: true, allocationIncomplete: true }] });
  assert.equal(graphCompleteness(ambiguous).complete, false);
  assert.ok(graphCompleteness(ambiguous).incompleteReasons.includes(OBLIGATION_REASON.reimbursementAllocationIncomplete));
});

test('manual debt missing terms quarantines instead of inventing payment', () => {
  const graph = buildGraph({ debts: [{ id: 'misc', name: 'Misc', balance: 500, minPayment: 0 }] });
  assert.equal(graphCompleteness(graph).complete, false);
  assert.ok(graphCompleteness(graph).incompleteReasons.includes(OBLIGATION_REASON.debtTermsUnsupported));
});

test('closed/excluded credit card liability is omitted from graph reservations', () => {
  const graph = buildGraph({
    accounts: [
      { id: 'checking', name: 'Checking', role: 'operating_cash', balance: 5000, closed: false, hidden: false },
      { id: 'card', name: 'Card', role: 'credit_card', balance: -900, closed: true, hidden: false },
    ],
    operatingAccountIds: ['checking'],
  });
  const liabilityNodes = graph.nodes.filter((node) => node.kind === 'credit_liability');
  assert.equal(liabilityNodes.length, 0);
});

test('EOM and leap recurrence produce stable occurrence ids', () => {
  const schedule = inferRecurrenceSchedule({
    cadence: 'monthly',
    dates: ['2026-01-31', '2026-02-28', '2026-03-31'],
    forced: true,
  });
  const dates = projectOccurrences({ schedule, windowStart: TODAY, windowEnd: WINDOW_END });
  assert.ok(dates.includes('2026-07-31'));
  const idA = stableOccurrenceId('bill:rent|2026-07-31', '2026-07-31', OCCURRENCE_ROLE.CASH_OUTFLOW);
  const idB = stableOccurrenceId('bill:rent|2026-07-31', '2026-07-31', OCCURRENCE_ROLE.CASH_OUTFLOW);
  assert.equal(idA, idB);
});

test('same-name distinct obligations remain separate by durable identity', () => {
  const graph = buildGraph({
    bills: {
      bills: [
        { id: 'a|2026-08-01', key: 'a', payee: 'City Water', dueDate: '2026-08-01', amount: 80, paid: false },
        { id: 'b|2026-08-01', key: 'b', payee: 'City Water', dueDate: '2026-08-01', amount: 45, paid: false },
      ],
    },
  });
  const payees = graph.occurrences.filter((occ) => occ.date === '2026-08-01' && occ.reserved);
  assert.equal(payees.length, 2);
  assert.notEqual(payees[0].durableIdentity, payees[1].durableIdentity);
});

test('duplicate durable identity fails closed', () => {
  const shared = 'obligation:shared:utility';
  const dup = buildObligationGraph({
    financeDate: TODAY,
    windowStart: TODAY,
    windowEnd: WINDOW_END,
    operatingAccountIds: ['checking'],
    recurringItems: [],
    billOccurrences: [{
      durableIdentity: shared,
      id: 'bill-one',
      key: 'utility',
      payee: 'Utility',
      dueDate: '2026-08-01',
      amountCents: 1000,
      paid: false,
    }],
    incomeStreams: [],
    manualDebts: [{
      durableIdentity: shared,
      id: 'debt-one',
      name: 'Utility debt',
      dueDate: '2026-08-01',
      paymentCents: 1000,
      principalCents: 1000,
      interestCents: 0,
    }],
    creditLiabilities: [],
    budgetReservations: [],
    reimbursementExpectations: [],
    transfers: [],
    economicTransactions: [],
  });
  assert.equal(graphCompleteness(dup).complete, false);
  assert.ok(graphCompleteness(dup).incompleteReasons.includes(OBLIGATION_REASON.duplicateIdentity));
});

test('permutation determinism: shuffled inputs yield identical graph ids', () => {
  const bills = [
    { id: 'z|2026-09-01', key: 'z', payee: 'Z', dueDate: '2026-09-01', amount: 10, paid: false },
    { id: 'a|2026-08-01', key: 'a', payee: 'A', dueDate: '2026-08-01', amount: 20, paid: false },
  ];
  const first = buildGraph({ bills: { bills: [...bills].reverse() } });
  const second = buildGraph({ bills: { bills: [...bills] } });
  assert.deepEqual(
    first.occurrences.map((occ) => occ.id),
    second.occurrences.map((occ) => occ.id),
  );
});

test('signed cents conservation: reserved outflows never double-count within dedupe group', () => {
  const graph = buildGraph({
    bills: {
      bills: [{
        id: 'power|2026-08-10',
        key: 'power',
        payee: 'Power Co',
        dueDate: '2026-08-10',
        amount: 120,
        paid: false,
      }],
    },
  });
  const check = verifyGraphInvariants(graph);
  assert.equal(check.ok, true, check.issues.join('; '));
});

test('default missing credit policy quarantines without treating Actual balance as statement', () => {
  const graph = buildGraph({
    accounts: [
      { id: 'checking', name: 'Checking', role: 'operating_cash', balance: 5000, closed: false, hidden: false },
      { id: 'card', name: 'Card', role: 'credit_card', balance: -500, closed: false, hidden: false },
    ],
    operatingAccountIds: ['checking'],
  });
  assert.equal(graph.nodes.filter((node) => node.kind === 'credit_liability').length, 0);
  assert.equal(graphCompleteness(graph).complete, true);
});

test('complete graph Safe-to-Spend conserves operating cash minus reservations', () => {
  const graph = buildGraph({
    budgets: {
      supported: true,
      groups: [{
        name: 'Everyday',
        categories: [
          { id: 'groceries', name: 'Groceries', remaining: 100 },
          { id: 'dining', name: 'Dining', remaining: 200 },
        ],
      }],
    },
  });
  const stf = safeToSpendFromGraph(graph, {
    operatingCashCents: 500000,
    monthStart: TODAY,
    monthEnd: monthEnd(TODAY.slice(0, 7)),
  });
  assert.equal(stf.complete, true);
  assert.equal(stf.valueCents, 470000);
});

test('forecast cash events exclude budget reservations (daily allocation stays separate)', () => {
  const graph = buildGraph();
  const events = forecastCashEventsFromGraph(graph, { windowStart: TODAY, windowEnd: addDays(TODAY, 45) });
  assert.ok(events.every((event) => event.kind !== 'budget'));
});

test('property: occurrence cap fails closed', () => {
  const projected = [];
  for (let i = 0; i < 100001; i++) projected.push({ date: addDays(TODAY, i % 90), amountCents: 100, paid: false });
  const graph = buildObligationGraph({
    financeDate: TODAY,
    windowStart: TODAY,
    windowEnd: addDays(TODAY, 365),
    operatingAccountIds: ['checking'],
    recurringItems: [{
      key: 'spam',
      durableIdentity: recurringDurableIdentity('spam'),
      payee: 'Spam',
      isBill: true,
      scheduleUncertain: false,
      projectedOccurrences: projected,
    }],
    billOccurrences: [],
    incomeStreams: [],
    manualDebts: [],
    creditLiabilities: [],
    budgetReservations: [],
    reimbursementExpectations: [],
    transfers: [],
    economicTransactions: [],
  });
  assert.ok(graphCompleteness(graph).incompleteReasons.includes(OBLIGATION_REASON.occurrenceCapExceeded));
});

test('bridge classifies mutual-reference transfers as non-ambiguous graph inputs', () => {
  const { buildCategoryInfo } = require('../lib/domain/classification');
  const patterns = {
    incomeGroup: /^income$/i,
    moneyMovementGroup: /money movement/i,
    moneyMovementCategory: /^transfer$/i,
    reimbursementCategory: /^reimbursement$/i,
  };
  const catInfo = buildCategoryInfo([
    { name: 'Money Movement', categories: [{ id: 'transfer', name: 'Transfer' }] },
  ], patterns);
  const rows = [{
    transaction: {
      id: 'out',
      date: '2026-07-20',
      amount: -5000,
      transfer_id: 'in',
      category: 'transfer',
    },
    accountId: 'checking',
  }, {
    transaction: {
      id: 'in',
      date: '2026-07-20',
      amount: 5000,
      transfer_id: 'out',
      category: 'transfer',
    },
    accountId: 'savings',
  }];
  const { transfers, economicTransactions } = buildGraphTransactionInputs(rows, catInfo, {
    windowStart: TODAY,
    windowEnd: WINDOW_END,
    accountRolesById: { checking: 'operating_cash', savings: 'protected_savings' },
  });
  assert.equal(transfers.length, 2);
  assert.ok(transfers.every((transfer) => transfer.ambiguous === false));
  assert.equal(economicTransactions.length, 0);
  const graph = buildObligationGraph({
    financeDate: TODAY,
    windowStart: TODAY,
    windowEnd: WINDOW_END,
    operatingAccountIds: ['checking'],
    recurringItems: [],
    billOccurrences: [],
    incomeStreams: [],
    manualDebts: [],
    creditLiabilities: [],
    budgetReservations: [],
    reimbursementExpectations: [],
    transfers,
    economicTransactions: [],
  });
  assert.equal(graphCompleteness(graph).complete, true);
});

test('adversarial: unsafe cent amounts throw before graph build', () => {
  assert.throws(() => buildObligationGraph({
    financeDate: TODAY,
    windowStart: TODAY,
    windowEnd: WINDOW_END,
    operatingAccountIds: ['checking'],
    billCategoryIds: [],
    recurringItems: [],
    billOccurrences: [{
      durableIdentity: 'bill:bad|2026-08-01',
      id: 'bad',
      key: 'bad',
      payee: 'Bad',
      dueDate: '2026-08-01',
      amountCents: 10.5,
      paid: false,
    }],
    incomeStreams: [],
    manualDebts: [],
    creditLiabilities: [],
    budgetReservations: [],
    reimbursementExpectations: [],
    transfers: [],
    economicTransactions: [],
  }), /safe integer cent amount/);
});

test('active non-bill recurrence projects reserved cash outflow or quarantines legacy reason', () => {
  const graph = buildGraph({
    recurring: {
      items: [{
        key: 'netflix',
        payee: 'Netflix',
        status: 'active',
        isBill: false,
        cadence: 'monthly',
        amount: 15.99,
        forced: true,
        history: [{ date: '2026-05-17', amount: 15.99 }, { date: '2026-06-17', amount: 15.99 }],
      }],
    },
  });
  const subs = graph.occurrences.filter((occ) => occ.dedupeGroup === 'sub-series:netflix');
  assert.ok(subs.length >= 1);
  assert.ok(subs.some((occ) => occ.role === OCCURRENCE_ROLE.CASH_OUTFLOW && occ.reserved));
});

test('bill and liability cycle merge to one reservation via funding ledger', () => {
  const graph = buildObligationGraph({
    financeDate: TODAY,
    windowStart: TODAY,
    windowEnd: WINDOW_END,
    operatingAccountIds: ['checking'],
    fundingAccountsByLiability: { card: 'checking' },
    billCategoryIds: [],
    creditLiabilities: [{
      durableIdentity: 'liability:credit:card',
      accountId: 'card',
      name: 'Card',
      eligible: true,
      obligationCents: 10000,
      coverageKind: 'current_balance',
      paymentDueDate: '2026-08-01',
      paymentRecurringKey: 'card-pay',
      fundingAccountId: 'checking',
      cycleKey: 'liability-cycle:card:2026-08-01',
      quarantineReasons: [],
    }],
    billOccurrences: [{
      durableIdentity: 'bill:card-pay|2026-08-01',
      id: 'card-pay|2026-08-01',
      key: 'card-pay',
      payee: 'Card Pay',
      dueDate: '2026-08-01',
      amountCents: 10000,
      paid: false,
      liabilityCycleKey: 'liability-cycle:card:2026-08-01',
    }],
    recurringItems: [],
    incomeStreams: [],
    manualDebts: [],
    transfers: [],
    budgetReservations: [],
    reimbursementExpectations: [],
    economicTransactions: [],
  });
  const reserved = graph.occurrences.filter((occ) => occ.reserved && occ.role === OCCURRENCE_ROLE.CASH_OUTFLOW);
  assert.equal(reserved.length, 0);
  const billOcc = graph.occurrences.find((occ) => occ.source?.kind === 'bill');
  assert.equal(billOcc?.reserved, false);
  assert.equal(billOcc?.suppressedBy != null, true);
});

test('future transfer funding reduces liability reserve without reposting past transfers', () => {
  const graph = buildObligationGraph({
    financeDate: TODAY,
    windowStart: TODAY,
    windowEnd: WINDOW_END,
    operatingAccountIds: ['checking'],
    fundingAccountsByLiability: { card: 'checking' },
    billCategoryIds: [],
    creditLiabilities: [{
      durableIdentity: 'liability:credit:card',
      accountId: 'card',
      name: 'Card',
      eligible: true,
      obligationCents: 10000,
      coverageKind: 'current_balance',
      paymentDueDate: '2026-08-01',
      paymentRecurringKey: 'card-pay',
      fundingAccountId: 'checking',
      cycleKey: 'liability-cycle:card:2026-08-01',
      quarantineReasons: [],
    }],
    transfers: [{
      durableIdentity: 'transfer:fund-future',
      linkId: 'fund-future',
      date: '2026-08-01',
      amountCents: -3000,
      fromAccountId: 'checking',
      toAccountId: 'card',
      ambiguous: false,
      fundsLiabilityAccountId: 'card',
    }, {
      durableIdentity: 'transfer:fund-posted',
      linkId: 'fund-posted',
      date: '2026-07-17',
      amountCents: -2000,
      fromAccountId: 'checking',
      toAccountId: 'card',
      ambiguous: false,
      fundsLiabilityAccountId: 'card',
    }],
    recurringItems: [],
    billOccurrences: [],
    incomeStreams: [],
    manualDebts: [],
    budgetReservations: [],
    reimbursementExpectations: [],
    economicTransactions: [],
  });
  const liability = graph.occurrences.find((occ) => occ.source?.kind === 'credit_liability');
  assert.equal(liability.components.remainingReserveCents, 7000);
  assert.equal(liability.amountCents, -7000);
  assert.equal(liability.components.postedFundingCents, 2000);
  assert.equal(liability.components.futureFundingCents, 3000);
});

test('incomplete graph yields no forecast cash events', () => {
  const graph = buildGraph({ reimbLinks: [{ ambiguous: true, allocationIncomplete: true }] });
  const events = forecastCashEventsFromGraph(graph, { windowStart: TODAY, windowEnd: WINDOW_END });
  assert.deepEqual(events, []);
});

test('statement coverage rejects stale observedAt', () => {
  const { resolveAccountCreditPolicy } = require('../lib/domain/credit-liability-policy');
  const policy = resolveAccountCreditPolicy({
    id: 'card',
    role: 'credit_card',
    balance: -100,
    financeDate: '2026-07-17',
  }, {
    creditLiabilityCoverage: 'statement',
    paymentRecurringKey: 'card-pay',
    statement: {
      balanceCents: -10000,
      paymentDueDate: '2026-08-01',
      observedAt: '2026-01-01T00:00:00.000Z',
    },
  });
  assert.ok(policy.quarantineReasons.includes('obligation_source_stale'));
});

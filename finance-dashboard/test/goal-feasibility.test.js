'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  accountAllocationSummary,
  buildGoalAdvisory,
  enrichGoalFeasibility,
  enrichGoalsResponse,
  goalRemainingCents,
} = require('../lib/domain/goal-feasibility');
const { fromCents, toCents } = require('../lib/domain/money');

test('goal remaining uses exact cents and ignores transient balance drift on save semantics', () => {
  assert.equal(goalRemainingCents({ target: 100, current: 33.33 }), toCents(66.67));
});

test('multiple same-account goals aggregate allocations without rejecting', () => {
  const goals = [
    { id: 'g1', accountId: 'acc1', current: 40, target: 100 },
    { id: 'g2', accountId: 'acc1', current: 35, target: 100 },
    { id: 'g3', accountId: 'acc1', current: 30, target: 100 },
  ];
  const summary = accountAllocationSummary({ goals, accountId: 'acc1', balanceCents: toCents(100) });
  assert.equal(summary.overAllocatedCents, toCents(5));
  assert.deepEqual(summary.goalIds, ['g1', 'g2', 'g3']);
});

test('protected savings account role is advisory-only with honest label', () => {
  const enriched = enrichGoalsResponse({
    financeDate: '2026-07-18',
    accounts: [{ id: 'save', role: 'protected_savings', closed: false, hidden: false }],
    balanceCentsById: new Map([['save', toCents(100)]]),
    goals: [{ id: 'g1', name: 'EF', target: 200, current: 120, accountId: 'save' }],
  });
  assert.equal(enriched.goals[0].feasibility.accountRole, 'protected_savings');
  assert.equal(enriched.goals[0].feasibility.advisoryOnly, true);
});

test('deadline pressure includes overdue flag and monthly advisory cents', () => {
  const feasibility = enrichGoalFeasibility(
    { id: 'g1', target: 1200, current: 300, accountId: null, deadline: '2026-05' },
    { financeDate: '2026-07-18' },
  );
  assert.equal(feasibility.deadlineOverdue, true);
  assert.equal(feasibility.monthlyRequiredCents, toCents(900));
});

test('buildGoalAdvisory stays complete even when over-allocated', () => {
  const advisory = buildGoalAdvisory({
    accountSummaries: [{ accountId: 'acc1', overAllocatedCents: toCents(20), goalIds: ['g1'] }],
    goals: [{ id: 'g1', target: 100, current: 10, feasibility: { remainingCents: toCents(50), monthlyRequiredCents: toCents(50), advisoryOnly: true } }],
  });
  assert.equal(advisory.complete, true);
  assert.equal(advisory.advisoryOnly, true);
  assert.equal(advisory.overAllocatedAccountCount, 1);
});

test('missing linked account surfaces false feasibility without throwing', () => {
  const enriched = enrichGoalsResponse({
    financeDate: '2026-07-18',
    accounts: [],
    balanceCentsById: new Map(),
    goals: [{ id: 'g1', name: 'Trip', target: 500, current: 100, accountId: 'missing' }],
  });
  assert.equal(enriched.goals[0].feasibility.accountStatus, 'missing');
  assert.equal(enriched.goals[0].feasibility.feasible, false);
});

test('hidden-but-live account may remain feasible with hidden status', () => {
  const enriched = enrichGoalsResponse({
    financeDate: '2026-07-18',
    accounts: [{ id: 'save', role: 'operating_cash', closed: false, hidden: true }],
    balanceCentsById: new Map([['save', toCents(200)]]),
    goals: [{ id: 'g1', name: 'Trip', target: 500, current: 100, accountId: 'save' }],
  });
  assert.equal(enriched.goals[0].feasibility.accountStatus, 'hidden');
  assert.equal(enriched.goals[0].feasibility.feasible, true);
});

test('excluded account never reports feasible true', () => {
  const enriched = enrichGoalsResponse({
    financeDate: '2026-07-18',
    accounts: [{ id: 'save', role: 'excluded', closed: false, hidden: false }],
    balanceCentsById: new Map([['save', toCents(200)]]),
    goals: [{ id: 'g1', name: 'Trip', target: 500, current: 100, accountId: 'save' }],
  });
  assert.equal(enriched.goals[0].feasibility.accountStatus, 'excluded');
  assert.equal(enriched.goals[0].feasibility.feasible, false);
});

test('goal advisory monthly pressure sums deadline goals only', () => {
  const enriched = enrichGoalsResponse({
    financeDate: '2026-07-18',
    accounts: [],
    balanceCentsById: new Map(),
    goals: [
      { id: 'g1', target: 1200, current: 0, deadline: '2026-12' },
      { id: 'g2', target: 500, current: 0, deadline: null },
    ],
  });
  assert.ok(enriched.goalAdvisory.monthlyPressureCents > 0);
  assert.ok(enriched.goalAdvisory.totalRemainingCents > toCents(500));
});

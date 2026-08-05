'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toCents } = require('../lib/domain/money');
const { allocateInflow } = require('../dataModule');

function expense(id, remainingCents, date) {
  return {
    id,
    date,
    payee: `Expense ${id}`,
    amount: -remainingCents / 100,
    remaining: remainingCents / 100,
  };
}

function assertConservesCents(inflowCents, expenses, result) {
  const remainingById = new Map(expenses.map((entry) => [entry.id, toCents(entry.remaining)]));
  const allocationCents = result.allocations.map((entry) => {
    const cents = toCents(entry.amount);
    assert.ok(cents > 0);
    assert.ok(cents <= remainingById.get(entry.expense.id));
    return cents;
  });
  const allocatedCents = allocationCents.reduce((sum, cents) => sum + cents, 0);
  assert.equal(toCents(result.matched), allocatedCents);
  assert.ok(allocatedCents <= inflowCents);
  assert.ok(allocatedCents <= [...remainingById.values()].reduce((sum, cents) => sum + cents, 0));
}

test('allocateInflow conserves exact cents for exact, subset, greedy, and overpayment matches', () => {
  const cases = [
    {
      inflowCents: 12_345,
      expenses: [expense('exact', 12_345, '2026-01-01')],
      kind: 'exact',
    },
    {
      inflowCents: 10_101,
      expenses: [
        expense('subset-a', 4_037, '2026-01-01'),
        expense('subset-b', 6_064, '2026-01-02'),
      ],
      kind: 'subset',
    },
    {
      inflowCents: 10_101,
      expenses: [
        expense('bounded-a', 6_000, '2026-01-01'),
        expense('bounded-b', 4_200, '2026-01-02'),
      ],
      kind: 'subset',
    },
    {
      inflowCents: 5_001,
      expenses: Array.from({ length: 6 }, (_, index) =>
        expense(`greedy-${index}`, 999, `2026-01-0${index + 1}`)),
      kind: 'multi',
    },
    {
      inflowCents: 10_000,
      expenses: [
        expense('over-a', 1_000, '2026-01-01'),
        expense('over-b', 1_000, '2026-01-02'),
      ],
      kind: 'over',
    },
  ];

  for (const entry of cases) {
    const result = allocateInflow({ amount: entry.inflowCents / 100 }, entry.expenses);
    assert.equal(result.kind, entry.kind);
    assertConservesCents(entry.inflowCents, entry.expenses, result);
  }
});

test('allocateInflow deterministically caps tolerance matches at inflow cents', () => {
  const expenses = [
    expense('a', 6_000, '2026-01-01'),
    expense('b', 4_200, '2026-01-02'),
  ];
  const result = allocateInflow({ amount: 101.01 }, expenses);

  assert.deepEqual(result.allocations.map((entry) => toCents(entry.amount)), [6_000, 4_101]);
  assert.equal(toCents(result.matched), 10_101);
  assertConservesCents(10_101, expenses, result);
});

test('allocateInflow conservation holds across varied cent inputs', () => {
  for (let index = 0; index < 50; index += 1) {
    const inflowCents = 8_000 + (index * 137);
    const expenses = [
      expense(`a-${index}`, 1_379 + index, '2026-01-01'),
      expense(`b-${index}`, 2_468 + (index * 2), '2026-01-02'),
      expense(`c-${index}`, 3_511 + (index * 3), '2026-01-03'),
      expense(`d-${index}`, 4_987 + (index * 5), '2026-01-04'),
    ];
    assertConservesCents(
      inflowCents,
      expenses,
      allocateInflow({ amount: inflowCents / 100 }, expenses),
    );
  }
});

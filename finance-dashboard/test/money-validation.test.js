const test = require('node:test');
const assert = require('node:assert/strict');
const { RequestValidationError } = require('../lib/errors');
const { parse, schemas } = require('../lib/validation');

const reimbRef = (id, amount) => ({
  id,
  date: '2026-07-09',
  payee: id,
  amount,
  accountId: 'a1',
  account: 'Checking',
  imported: false,
});

const moneyFields = [
  {
    name: 'createTransaction.amount',
    schema: schemas.createTransaction,
    build: (amount) => ({ accountId: 'a1', amount }),
    valid: [-100_000_000, -7.34, -0.01, 0.01, 7.34, 100_000_000],
    policyInvalid: [0],
  },
  {
    name: 'splitTransaction.legs[].amount',
    schema: schemas.splitTransaction,
    build: (amount) => ({
      accountId: 'a1',
      date: '2026-07-09',
      legs: [{ amount }, { amount: 1 }],
    }),
    valid: [-100_000_000, -7.34, -0.01, 0.01, 7.34, 100_000_000],
    policyInvalid: [0],
  },
  {
    name: 'budget.amount',
    schema: schemas.budget,
    build: (amount) => ({ categoryId: 'c1', amount }),
    valid: [0, 0.01, 7.34, 100_000_000],
    policyInvalid: [-0.01, -100_000_000],
  },
  {
    name: 'manualAsset.value',
    schema: schemas.manualAsset,
    build: (value) => ({ name: 'Brokerage', value, kind: 'asset' }),
    valid: [0.01, 7.34, 100_000_000],
    policyInvalid: [-100_000_000, -0.01, 0],
  },
  {
    name: 'goal.target',
    schema: schemas.goal,
    build: (target) => ({ name: 'Emergency fund', target }),
    valid: [0.01, 7.34, 100_000_000],
    policyInvalid: [-100_000_000, -0.01, 0],
  },
  {
    name: 'goal.current',
    schema: schemas.goal,
    build: (current) => ({ name: 'Emergency fund', target: 100, current }),
    omit: () => ({ name: 'Emergency fund', target: 100 }),
    valid: [0, 0.01, 7.34, 100_000_000],
    policyInvalid: [-0.01, -100_000_000],
    optional: true,
  },
  {
    name: 'receipt.amount',
    schema: schemas.receipt,
    build: (amount) => ({
      txnId: 't1',
      accountId: 'a1',
      transactionDate: '2026-07-09',
      imageBase64: 'abc',
      mime: 'image/jpeg',
      amount,
    }),
    omit: () => ({
      txnId: 't1',
      accountId: 'a1',
      transactionDate: '2026-07-09',
      imageBase64: 'abc',
      mime: 'image/jpeg',
    }),
    valid: [-100_000_000, -7.34, -0.01, 0, 0.01, 7.34, 100_000_000],
    policyInvalid: [],
    optional: true,
    nullable: true,
  },
  {
    name: 'reimbLink.inflow.amount',
    schema: schemas.reimbLink,
    build: (amount) => ({
      inflow: reimbRef('inflow', amount),
      expense: reimbRef('expense', -7.34),
      allocationCents: 734,
    }),
    valid: [-100_000_000, -7.34, -0.01, 0, 0.01, 7.34, 100_000_000],
    policyInvalid: [],
  },
  {
    name: 'reimbLink.expense.amount',
    schema: schemas.reimbLink,
    build: (amount) => ({
      inflow: reimbRef('inflow', 7.34),
      expense: reimbRef('expense', amount),
      allocationCents: 734,
    }),
    valid: [-100_000_000, -7.34, -0.01, 0, 0.01, 7.34, 100_000_000],
    policyInvalid: [],
  },
  {
    name: 'reimbLink.allocationCents',
    schema: schemas.reimbLink,
    build: (amount) => ({
      inflow: reimbRef('inflow', 7.34),
      expense: reimbRef('expense', -7.34),
      allocationCents: amount,
    }),
    valid: [1, 734, 10_000_000_000],
    policyInvalid: [-1, 0],
  },
  {
    name: 'reimbLink.amount',
    schema: schemas.reimbLink,
    build: (amount) => ({
      inflow: reimbRef('inflow', 7.34),
      expense: reimbRef('expense', -7.34),
      amount,
    }),
    omit: () => ({
      inflow: reimbRef('inflow', 7.34),
      expense: reimbRef('expense', -7.34),
      allocationCents: 734,
    }),
    valid: [0.01, 7.34, 100_000_000],
    policyInvalid: [-100_000_000, -0.01, 0],
    optional: true,
  },
  {
    name: 'owesConfig.manualTrips.*[].amount',
    schema: schemas.owesConfig,
    build: (amount) => ({ manualTrips: { person: [{ event: 'trip', amount }] } }),
    valid: [0, 0.01, 7.34, 100_000_000],
    policyInvalid: [-0.01, -100_000_000],
  },
];

const malformedMoney = [
  '7.34',
  '',
  'NaN',
  'Infinity',
  '-Infinity',
  true,
  false,
  [],
  [7.34],
  {},
  NaN,
  Infinity,
  -Infinity,
  -0,
  1.005,
  -1.005,
  0.001,
  -0.001,
  100_000_000.01,
  -100_000_000.01,
  Number.MAX_VALUE,
];

function describeValue(value) {
  if (Object.is(value, -0)) return '-0';
  if (Number.isNaN(value)) return 'NaN';
  return JSON.stringify(value);
}

for (const field of moneyFields) {
  test(`${field.name} accepts only exact-cent JSON numbers within its sign policy`, () => {
    for (const value of field.valid) {
      assert.doesNotThrow(
        () => parse(field.schema, field.build(value)),
        `${field.name} should accept ${describeValue(value)}`
      );
    }
    for (const value of [...malformedMoney, ...field.policyInvalid]) {
      assert.throws(
        () => parse(field.schema, field.build(value)),
        RequestValidationError,
        `${field.name} should reject ${describeValue(value)}`
      );
    }
  });

  test(`${field.name} preserves its nullable and optional contract`, () => {
    if (field.nullable) {
      assert.doesNotThrow(() => parse(field.schema, field.build(null)));
    } else {
      assert.throws(() => parse(field.schema, field.build(null)), RequestValidationError);
    }
    if (field.optional) {
      assert.doesNotThrow(() => parse(field.schema, field.omit()));
    }
  });
}

for (const field of [{
  name: 'owesConfig.expected.*.* cents',
  build: (amount) => ({ expected: { trip: { person: amount } } }),
}]) {
  test(`${field.name} requires safe non-negative integer cents`, () => {
    for (const value of [0, 1, 734, 10_000_000_000]) {
      assert.doesNotThrow(() => parse(schemas.owesConfig, field.build(value)));
    }
    for (const value of ['734', null, true, false, -0, -1, 1.5, 10_000_000_001, Number.MAX_SAFE_INTEGER]) {
      assert.throws(
        () => parse(schemas.owesConfig, field.build(value)),
        RequestValidationError,
        `${field.name} should reject ${describeValue(value)}`
      );
    }
  });
}

test('existing native numeric money payloads remain compatible', () => {
  const payloads = [
    [schemas.createTransaction, { accountId: 'a1', amount: -7.34, payee: 'Coffee', date: '2026-07-09', categoryId: null }],
    [schemas.budget, { month: '2026-07', categoryId: 'c1', amount: 734.56 }],
    [schemas.splitTransaction, {
      accountId: 'a1',
      date: '2026-07-09',
      legs: [
        { id: 'l1', amount: -5, categoryId: 'c1', name: '', notes: '' },
        { amount: -7.34, categoryId: null, name: 'Friend', notes: 'share' },
      ],
    }],
    [schemas.manualAsset, { id: 'm1', name: 'Brokerage', value: 1250.5, kind: 'asset' }],
    [schemas.goal, { id: 'g1', name: 'Emergency fund', target: 5000, current: 734.56, accountId: null, deadline: null }],
    [schemas.receipt, {
      txnId: 't1',
      accountId: 'a1',
      transactionDate: '2026-07-09',
      imageBase64: 'abc',
      mime: 'image/jpeg',
      amount: 12.34,
      date: null,
      source: 'camera',
    }],
    [schemas.reimbLink, {
      inflow: reimbRef('inflow', 112.5),
      expense: reimbRef('expense', -112.5),
      allocationCents: 5000,
    }],
  ];
  for (const [schema, payload] of payloads) {
    assert.doesNotThrow(() => parse(schema, payload));
  }
});

test('exponent notation is judged by the parsed JSON number, not its spelling', () => {
  const exactCent = JSON.parse('{"accountId":"a1","amount":1e-2}');
  const fractionalCent = JSON.parse('{"accountId":"a1","amount":1e-3}');
  assert.doesNotThrow(() => parse(schemas.createTransaction, exactCent));
  assert.throws(() => parse(schemas.createTransaction, fractionalCent), RequestValidationError);
});

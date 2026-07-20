'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildForecastProjectionContainment,
  buildForecastStsContainment,
  forecastContainmentWarnings,
} = require('../lib/domain/forecast-containment');
const {
  merchantTrendsConservationOk,
  merchantTrendsFromClassifiedLeaves,
} = require('../lib/domain/projection-completeness');
const { fromCents, sumCents } = require('../lib/domain/money');

test('buildForecastProjectionContainment labels known graph events when STS remains incomplete', () => {
  const stsContainment = buildForecastStsContainment({
    complete: false,
    incompleteReasons: ['budget_data_unavailable'],
  });
  const projectionContainment = buildForecastProjectionContainment({
    stsContainment,
    withholdGraphEvents: false,
    knownEventCount: 2,
  });
  assert.equal(projectionContainment.complete, false);
  assert.equal(projectionContainment.stsContainmentIncomplete, true);
  assert.equal(projectionContainment.graphEventsWithheld, false);
  assert.equal(projectionContainment.knownEventsIncludedDespiteStsIncomplete, true);
  assert.ok(projectionContainment.incompleteReasons.includes('budget_data_unavailable'));
});

test('forecastContainmentWarnings describe withheld graph and STS reasons', () => {
  const stsContainment = buildForecastStsContainment({
    complete: false,
    incompleteReasons: ['rollover_treatment_unknown'],
  });
  const projectionContainment = buildForecastProjectionContainment({
    stsContainment,
    withholdGraphEvents: true,
    knownEventCount: 0,
  });
  const warnings = forecastContainmentWarnings({
    stsContainment,
    projectionContainment,
    obligationGraphIncompleteReasons: ['recurrence_unresolved'],
  });
  assert.ok(warnings.some((warning) => /scheduled cash events withheld/.test(warning)));
  assert.ok(warnings.some((warning) => /Safe-to-Spend containment incomplete/.test(warning)));
  assert.ok(warnings.some((warning) => /Safe-to-Spend: rollover_treatment_unknown/.test(warning)));
  assert.ok(warnings.some((warning) => /Obligation graph: recurrence_unresolved/.test(warning)));
});

test('merchantTrendsFromClassifiedLeaves conserves authoritative total spend on full aggregate', () => {
  const leaves = [
    { payee: 'A', amount: -25000, kind: 'spend', countsAsSpending: true, countsAsIncome: false },
    { payee: 'B', amount: -15000, kind: 'spend', countsAsSpending: true, countsAsIncome: false },
    { payee: 'Transfer', amount: -90000, kind: 'mm', countsAsSpending: false, countsAsIncome: false },
  ];
  const trends = merchantTrendsFromClassifiedLeaves(leaves);
  assert.equal(trends.all.length, 2);
  assert.equal(trends.top.length, 2);
  assert.equal(trends.truncated, false);
  assert.equal(merchantTrendsConservationOk(trends.aggregateSpendCents, 400), true);
  assert.equal(merchantTrendsConservationOk(trends.aggregateSpendCents, 250), false);
});

test('merchantTrendsFromClassifiedLeaves nets same-payee refunds into authoritative spend', () => {
  const leaves = [
    { payee: 'Store', amount: -10000, kind: 'spend', countsAsSpending: true, countsAsIncome: false },
    { payee: 'Store', amount: 3000, kind: 'spend', countsAsSpending: true, countsAsIncome: false },
  ];
  const trends = merchantTrendsFromClassifiedLeaves(leaves);
  assert.equal(trends.all.length, 1);
  assert.equal(trends.all[0].spend, 70);
  assert.equal(trends.all[0].count, 2);
  assert.equal(merchantTrendsConservationOk(trends.aggregateSpendCents, 70), true);
});

test('merchantTrendsFromClassifiedLeaves truncates display while full aggregate conserves total spend', () => {
  const leaves = Array.from({ length: 13 }, (_, index) => ({
    payee: `Merchant ${String(index).padStart(2, '0')}`,
    amount: -(10000 + index * 100),
    kind: 'spend',
    countsAsSpending: true,
    countsAsIncome: false,
  }));
  const trends = merchantTrendsFromClassifiedLeaves(leaves, { limit: 12 });
  const totalSpend = fromCents(sumCents(leaves.map((leaf) => -leaf.amount)));
  assert.equal(trends.all.length, 13);
  assert.equal(trends.top.length, 12);
  assert.equal(trends.truncated, true);
  assert.equal(merchantTrendsConservationOk(trends.aggregateSpendCents, totalSpend), true);
});

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

test('merchantTrendsFromClassifiedLeaves conserves authoritative total spend', () => {
  const leaves = [
    { payee: 'A', amount: -25000, kind: 'spend', countsAsSpending: true, countsAsIncome: false },
    { payee: 'B', amount: -15000, kind: 'spend', countsAsSpending: true, countsAsIncome: false },
    { payee: 'Transfer', amount: -90000, kind: 'mm', countsAsSpending: false, countsAsIncome: false },
  ];
  const trends = merchantTrendsFromClassifiedLeaves(leaves);
  assert.equal(trends.length, 2);
  assert.equal(merchantTrendsConservationOk(trends, 400), true);
  assert.equal(merchantTrendsConservationOk(trends, 250), false);
});

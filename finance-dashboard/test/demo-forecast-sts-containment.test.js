'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const demo = require('../demoData');

test('demo forecast exposes STS containment and labels projection incomplete when Today STS is incomplete', () => {
  const today = demo.today();
  const forecast = demo.forecast(30);

  assert.equal(today.liquidity.safeToSpend.complete, false);
  assert.ok(today.liquidity.safeToSpend.incompleteReasons.includes('budget_data_unavailable'));
  assert.ok(!today.liquidity.safeToSpend.incompleteReasons.includes('goal_commitment_unknown'));
  assert.equal(today.liquidity.goalAdvisory?.advisoryOnly, true);

  assert.equal(forecast.assumptions.stsContainment.complete, false);
  assert.deepEqual(
    forecast.assumptions.stsContainment.incompleteReasons,
    today.liquidity.safeToSpend.incompleteReasons,
  );

  assert.equal(forecast.assumptions.projectionContainment.complete, false);
  assert.equal(forecast.assumptions.projectionContainment.stsContainmentIncomplete, true);
  assert.equal(forecast.assumptions.projectionContainment.graphEventsWithheld, false);
  assert.equal(forecast.assumptions.projectionContainment.knownEventsIncludedDespiteStsIncomplete, true);
  assert.ok(forecast.events.length > 0);
  assert.ok(forecast.assumptions.projectionContainment.incompleteReasons.includes('budget_data_unavailable'));

  assert.equal(forecast.assumptions.genericBudget.complete, false);
  assert.ok(forecast.assumptions.genericBudget.incompleteReasons.includes('budget_data_unavailable'));
  assert.ok(!forecast.assumptions.genericBudget.incompleteReasons.includes('goal_commitment_unknown'));
  assert.equal(forecast.assumptions.genericBudgetTarget, null);

  assert.ok(forecast.warnings.some((warning) => /Safe-to-Spend containment incomplete/.test(warning)));
  assert.ok(forecast.warnings.some((warning) => /Safe-to-Spend: budget_data_unavailable/.test(warning)));
  assert.ok(forecast.warnings.some((warning) => /Known obligation graph cash events are included/.test(warning)));
});

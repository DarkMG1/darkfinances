'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeFallbackNetWorth,
  hasServerMetric,
  resolveMoneyMetric,
  resolveNetWorthAggregateDisplay,
  resolveWidgetNetWorthDecision,
} = require('../src/lib/account-metrics-core.js');

const accounts = [
  { id: 'a1', hidden: false, balance: 1000, inclusion: { netWorth: true } },
  { id: 'a2', hidden: false, balance: -200, inclusion: { netWorth: true } },
  { id: 'a3', hidden: false, balance: 5000, inclusion: { netWorth: false } },
];

test('resolveMoneyMetric treats absent metric as old-server fallback', () => {
  const resolved = resolveMoneyMetric(undefined, 1234);
  assert.equal(resolved.authoritative, false);
  assert.equal(resolved.unavailable, false);
  assert.equal(resolved.value, 1234);
});

test('resolveMoneyMetric marks complete authoritative values', () => {
  const resolved = resolveMoneyMetric({ complete: true, value: 2500, valueCents: 250000 }, 0);
  assert.equal(resolved.authoritative, true);
  assert.equal(resolved.value, 2500);
  assert.equal(resolved.unavailable, false);
});

test('resolveMoneyMetric marks incomplete server metrics unavailable', () => {
  const resolved = resolveMoneyMetric({
    complete: false,
    value: null,
    valueCents: null,
    incompleteReasons: ['account_balance_unavailable'],
  }, 999);
  assert.equal(resolved.unavailable, true);
  assert.equal(resolved.value, null);
  assert.deepEqual(resolved.reasons, ['account_balance_unavailable']);
});

test('computeFallbackNetWorth respects inclusion.netWorth and manual assets once', () => {
  assert.equal(
    computeFallbackNetWorth(accounts, { complete: true, assets: 100, liabilities: 25 }),
    875,
  );
});

test('resolveNetWorthAggregateDisplay hides aggregates when server metric incomplete', () => {
  const display = resolveNetWorthAggregateDisplay({
    resolved: resolveMoneyMetric({ complete: false, value: null, incompleteReasons: ['x'] }, 100),
    assets: 100,
    liabilities: -20,
  });
  assert.equal(display.showAggregates, false);
  assert.equal(display.assets, null);
  assert.match(display.unavailableLabel, /unavailable/i);
});

test('widget decision waits while Today is loading', () => {
  const decision = resolveWidgetNetWorthDecision({
    todayLoading: true,
    todaySettled: false,
    todayError: false,
    profileGeneration: 1,
    widgetProfileGeneration: 1,
    scope: 'scope-a',
    widgetScope: 'scope-a',
    accounts,
  });
  assert.equal(decision.action, 'wait');
  assert.equal(decision.reason, 'today_pending');
});

test('widget decision clears on profile scope change before Today settles', () => {
  const decision = resolveWidgetNetWorthDecision({
    todayLoading: false,
    todaySettled: false,
    todayError: false,
    profileGeneration: 2,
    widgetProfileGeneration: 2,
    scope: 'scope-b',
    widgetScope: 'scope-a',
    accounts,
  });
  assert.equal(decision.action, 'clear');
  assert.equal(decision.reason, 'profile_scope_changed');
});

test('widget decision clears when server metric is incomplete', () => {
  const decision = resolveWidgetNetWorthDecision({
    todayLoading: false,
    todaySettled: true,
    todayError: false,
    profileGeneration: 3,
    widgetProfileGeneration: 3,
    scope: 'scope-a',
    widgetScope: 'scope-a',
    serverMetric: { complete: false, value: null, incompleteReasons: ['account_balance_unavailable'] },
    accounts,
    manual: { complete: true, assets: 0, liabilities: 0 },
  });
  assert.equal(decision.action, 'clear');
  assert.equal(decision.reason, 'metric_incomplete');
});

test('widget decision pushes inclusion-aware fallback for old server without metric', () => {
  const decision = resolveWidgetNetWorthDecision({
    todayLoading: false,
    todaySettled: true,
    todayError: false,
    profileGeneration: 1,
    widgetProfileGeneration: 1,
    scope: 'scope-a',
    widgetScope: 'scope-a',
    serverMetric: undefined,
    accounts,
    manual: { complete: true, assets: 0, liabilities: 0 },
    prevTrendNetWorth: 700,
  });
  assert.equal(decision.action, 'push');
  assert.equal(decision.netWorth, 800);
  assert.equal(decision.changeDiff, 100);
  assert.equal(decision.authoritative, false);
});

test('widget decision pushes authoritative metric without local delta when trend missing', () => {
  const decision = resolveWidgetNetWorthDecision({
    todayLoading: false,
    todaySettled: true,
    todayError: false,
    profileGeneration: 4,
    widgetProfileGeneration: 4,
    scope: 'scope-a',
    widgetScope: 'scope-a',
    serverMetric: { complete: true, value: 900, valueCents: 90000 },
    accounts,
    prevTrendNetWorth: null,
  });
  assert.equal(decision.action, 'push');
  assert.equal(decision.netWorth, 900);
  assert.equal(decision.changeDiff, null);
  assert.equal(decision.authoritative, true);
});

test('hasServerMetric distinguishes old server from incomplete metric', () => {
  assert.equal(hasServerMetric(undefined), false);
  assert.equal(hasServerMetric({ complete: false, value: null }), true);
});

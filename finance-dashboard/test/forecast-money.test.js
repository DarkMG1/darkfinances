'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ForecastMoneyValidationError, classifyError } = require('../lib/errors');
const {
  forecastBillEventCents,
  forecastIncomeEventCents,
  requireForecastMoneyCents,
  sumOperatingCashBalanceCents,
} = require('../lib/domain/forecast-money');

test('requireForecastMoneyCents accepts cent-safe values', () => {
  assert.equal(requireForecastMoneyCents(12.34), 1234);
  assert.equal(requireForecastMoneyCents(-7.5), -750);
  assert.equal(requireForecastMoneyCents(0), 0);
});

test('requireForecastMoneyCents rejects fractional, nonfinite, and non-number inputs', () => {
  for (const value of [10.005, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '12.34']) {
    assert.throws(
      () => requireForecastMoneyCents(value),
      ForecastMoneyValidationError,
      String(value),
    );
  }
});

test('requireForecastMoneyCents rejects overflow balances with controlled error text', () => {
  assert.throws(
    () => requireForecastMoneyCents(Number.MAX_VALUE),
    (error) => error instanceof ForecastMoneyValidationError
      && error.message === 'Forecast money input is invalid'
      && !String(error.message).includes(String(Number.MAX_VALUE)),
  );
  const classified = classifyError(new ForecastMoneyValidationError());
  assert.equal(classified.code, 'FORECAST_MONEY_INVALID');
  assert.equal(classified.message, 'Forecast money input is invalid');
});

test('sumOperatingCashBalanceCents conserves valid account balances', () => {
  assert.equal(
    sumOperatingCashBalanceCents([{ balance: 100.01 }, { balance: -25.25 }]),
    7476,
  );
});

test('sumOperatingCashBalanceCents rejects invalid start balances fail-closed', () => {
  assert.throws(
    () => sumOperatingCashBalanceCents([{ balance: 100.001 }]),
    ForecastMoneyValidationError,
  );
  assert.throws(
    () => sumOperatingCashBalanceCents([{ balance: Number.NaN }]),
    ForecastMoneyValidationError,
  );
});

test('forecast income and bill helpers reject invalid production amounts', () => {
  assert.throws(() => forecastIncomeEventCents(10.005), ForecastMoneyValidationError);
  assert.throws(() => forecastBillEventCents(Number.POSITIVE_INFINITY), ForecastMoneyValidationError);
  assert.equal(forecastIncomeEventCents(2500), 250000);
  assert.equal(forecastBillEventCents(19.99), -1999);
});

'use strict';

const { ForecastMoneyValidationError } = require('../errors');
const { sumCents, toCents } = require('./money');

function requireForecastMoneyCents(value) {
  try {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError('forecast money must be a finite number');
    }
    return toCents(value);
  } catch (cause) {
    throw new ForecastMoneyValidationError(cause);
  }
}

function sumOperatingCashBalanceCents(accounts) {
  try {
    return sumCents((accounts || []).map((account) => requireForecastMoneyCents(account.balance)));
  } catch (cause) {
    if (cause instanceof ForecastMoneyValidationError) throw cause;
    throw new ForecastMoneyValidationError(cause);
  }
}

function forecastIncomeEventCents(amountDollars) {
  return requireForecastMoneyCents(Math.abs(amountDollars));
}

function forecastBillEventCents(amountDollars) {
  return -requireForecastMoneyCents(Math.abs(amountDollars));
}

module.exports = {
  forecastBillEventCents,
  forecastIncomeEventCents,
  requireForecastMoneyCents,
  sumOperatingCashBalanceCents,
};

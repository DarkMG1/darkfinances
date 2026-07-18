'use strict';

const { toCents } = require('./money');
const { addDays } = require('../date-only');

const COVERAGE_MODE = Object.freeze({
  UNKNOWN: 'unknown',
  EXCLUDE: 'exclude',
  CURRENT_BALANCE: 'current_balance',
  STATEMENT: 'statement',
});

const STATEMENT_MAX_AGE_DAYS = 45;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validIsoTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function normalizeCoverageMode(raw) {
  if (raw === COVERAGE_MODE.EXCLUDE || raw === 'exclude') return COVERAGE_MODE.EXCLUDE;
  if (raw === COVERAGE_MODE.CURRENT_BALANCE || raw === 'current_balance') return COVERAGE_MODE.CURRENT_BALANCE;
  if (raw === COVERAGE_MODE.STATEMENT || raw === 'statement') return COVERAGE_MODE.STATEMENT;
  return COVERAGE_MODE.UNKNOWN;
}

function resolveAccountCreditPolicy(account, overrideEntry = {}) {
  const mode = normalizeCoverageMode(overrideEntry.creditLiabilityCoverage);
  const paymentRecurringKey = typeof overrideEntry.paymentRecurringKey === 'string'
    ? overrideEntry.paymentRecurringKey.trim()
    : '';
  const fundingAccountId = typeof overrideEntry.fundingAccountId === 'string'
    ? overrideEntry.fundingAccountId.trim()
    : '';
  const statement = isPlainObject(overrideEntry.statement) ? overrideEntry.statement : null;

  if (account.closed || account.hidden || account.role === 'excluded') {
    return {
      accountId: account.id,
      eligible: false,
      excluded: true,
      mode: COVERAGE_MODE.EXCLUDE,
      quarantineReasons: [],
    };
  }

  if (account.role !== 'credit_card') {
    return {
      accountId: account.id,
      eligible: false,
      excluded: true,
      mode: COVERAGE_MODE.EXCLUDE,
      quarantineReasons: [],
    };
  }

  const currentBalanceCents = toCents(Number(account.balance) || 0);
  if (mode === COVERAGE_MODE.EXCLUDE) {
    return {
      accountId: account.id,
      eligible: false,
      excluded: true,
      mode,
      currentBalanceCents,
      quarantineReasons: [],
    };
  }

  if (mode === COVERAGE_MODE.UNKNOWN) {
    return {
      accountId: account.id,
      eligible: currentBalanceCents < 0,
      excluded: false,
      mode,
      currentBalanceCents,
      quarantineReasons: currentBalanceCents < 0 ? ['credit_card_coverage_unknown'] : [],
    };
  }

  if (!paymentRecurringKey) {
    return {
      accountId: account.id,
      eligible: true,
      excluded: false,
      mode,
      currentBalanceCents,
      paymentRecurringKey: null,
      quarantineReasons: ['obligation_liability_unresolved'],
    };
  }

  if (mode === COVERAGE_MODE.CURRENT_BALANCE) {
    if (currentBalanceCents >= 0) {
      return {
        accountId: account.id,
        eligible: false,
        excluded: false,
        mode,
        currentBalanceCents,
        paymentRecurringKey,
        fundingAccountId: fundingAccountId || null,
        obligationCents: 0,
        coverageKind: 'current_balance',
        quarantineReasons: [],
      };
    }
    return {
      accountId: account.id,
      eligible: true,
      excluded: false,
      mode,
      currentBalanceCents,
      paymentRecurringKey,
      fundingAccountId: fundingAccountId || null,
      obligationCents: Math.abs(currentBalanceCents),
      coverageKind: 'current_balance',
      quarantineReasons: [],
    };
  }

  if (mode === COVERAGE_MODE.STATEMENT) {
    const balanceCents = Number(statement?.balanceCents);
    const paymentDueDate = statement?.paymentDueDate;
    const observedAt = statement?.observedAt;
    const reasons = [];
    if (!Number.isSafeInteger(balanceCents) || balanceCents >= 0) reasons.push('obligation_liability_unresolved');
    if (!validIsoDate(paymentDueDate)) reasons.push('obligation_liability_unresolved');
    if (!validIsoTimestamp(observedAt)) reasons.push('obligation_liability_unresolved');
    if (validIsoTimestamp(observedAt)) {
      const observedDate = new Date(observedAt).toISOString().slice(0, 10);
      const financeDate = account.financeDate || observedDate;
      if (addDays(observedDate, STATEMENT_MAX_AGE_DAYS) < financeDate) {
        reasons.push('obligation_source_stale');
      }
    }
    return {
      accountId: account.id,
      eligible: reasons.length === 0 && balanceCents < 0,
      excluded: false,
      mode,
      currentBalanceCents,
      paymentRecurringKey,
      fundingAccountId: fundingAccountId || null,
      obligationCents: Number.isSafeInteger(balanceCents) ? Math.abs(balanceCents) : null,
      paymentDueDate: validIsoDate(paymentDueDate) ? paymentDueDate : null,
      observedAt: observedAt || null,
      coverageKind: 'statement',
      quarantineReasons: reasons,
    };
  }

  return {
    accountId: account.id,
    eligible: false,
    excluded: true,
    mode: COVERAGE_MODE.UNKNOWN,
    quarantineReasons: [],
  };
}

function resolvePaymentLink(recurringItems, paymentRecurringKey) {
  const matches = (recurringItems || []).filter((item) => item.key === paymentRecurringKey && item.status === 'active');
  if (matches.length !== 1) {
    return { linked: false, ambiguous: matches.length > 1, item: null };
  }
  return { linked: true, ambiguous: false, item: matches[0] };
}

function liabilityCycleKey(accountId, dueDate) {
  return `liability-cycle:${accountId}:${dueDate}`;
}

module.exports = {
  COVERAGE_MODE,
  STATEMENT_MAX_AGE_DAYS,
  liabilityCycleKey,
  normalizeCoverageMode,
  resolveAccountCreditPolicy,
  resolvePaymentLink,
};

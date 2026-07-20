const { parseStrictAllocationDollars } = require('./allocation-parse');

const MAX_MONEY_DOLLARS = 100_000_000;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_ONLY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function validDateOnly(value) {
  const match = DATE_ONLY_RE.exec(String(value || '').trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseStrictMoneyDollars(text, { allowZero = false, allowNegative = false } = {}) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  if (/[,\s]/.test(trimmed)) return null;
  const sign = trimmed.startsWith('-') ? -1 : 1;
  const unsigned = sign < 0 ? trimmed.slice(1) : trimmed;
  if (!/^\d+(\.\d{1,2})?$/.test(unsigned)) return null;
  const value = sign * Number(unsigned);
  if (!Number.isFinite(value)) return null;
  if (!allowNegative && value < 0) return null;
  if (!allowZero && value === 0) return null;
  if (Math.abs(value) > MAX_MONEY_DOLLARS) return null;
  const cents = Math.round(value * 100);
  if (Math.abs(cents - value * 100) > 0.0001) return null;
  return value;
}

function validateDateOnlyField(value, label = 'Date') {
  const text = String(value ?? '').trim();
  if (!text) return `${label} is required.`;
  if (!validDateOnly(text)) return `${label} must be a real date in YYYY-MM-DD format.`;
  return null;
}

function validateMonthOnlyField(value, label = 'Month') {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (!MONTH_ONLY_RE.test(text)) return `${label} must be YYYY-MM, for example 2027-06.`;
  return null;
}

function validateMoneyField(text, { label = 'Amount', allowZero = false, allowNegative = false } = {}) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return `${label} is required.`;
  const value = parseStrictMoneyDollars(trimmed, { allowZero, allowNegative });
  if (value == null) {
    return `${label} must be a positive dollar amount with at most two decimal places (e.g. 20.00).`;
  }
  return null;
}

function validateAllocationField(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return 'Enter an allocation amount.';
  if (parseStrictAllocationDollars(trimmed) == null) {
    return 'Allocation must be a positive dollar amount with at most two decimal places.';
  }
  return null;
}

function validateRequiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) return `${label} is required.`;
  return null;
}

function collectFieldErrors(checks) {
  const fieldErrors = Object.create(null);
  for (const [field, message] of Object.entries(checks)) {
    if (message) fieldErrors[field] = message;
  }
  return fieldErrors;
}

module.exports = {
  collectFieldErrors,
  parseStrictMoneyDollars,
  validateAllocationField,
  validateDateOnlyField,
  validateMonthOnlyField,
  validateMoneyField,
  validateRequiredText,
  validDateOnly,
};

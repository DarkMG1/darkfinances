/** Fail-closed money formatting: absent/null/NaN → Unavailable; valid zero stays zero. */

const UNAVAILABLE_MONEY_LABEL = 'Unavailable';

function isKnownMoney(value) {
  return value != null && Number.isFinite(value);
}

function formatOptionalPos(value, fmtPos) {
  return isKnownMoney(value) ? fmtPos(value) : UNAVAILABLE_MONEY_LABEL;
}

function formatOptionalMoney(value, fmtMoney) {
  return isKnownMoney(value) ? fmtMoney(value) : UNAVAILABLE_MONEY_LABEL;
}

function formatOptionalSignedMoney(value, fmtSignedMoney) {
  return isKnownMoney(value) ? fmtSignedMoney(value) : UNAVAILABLE_MONEY_LABEL;
}

function completeMoneySeries(values) {
  if (!Array.isArray(values) || !values.every(isKnownMoney)) return [];
  return values;
}

module.exports = {
  UNAVAILABLE_MONEY_LABEL,
  completeMoneySeries,
  isKnownMoney,
  formatOptionalPos,
  formatOptionalMoney,
  formatOptionalSignedMoney,
};

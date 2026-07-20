/** Locale-independent strict dollars parser for reimbursement allocation input. */
function parseStrictAllocationDollars(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  if (/[,\s]/.test(trimmed)) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  const cents = Math.round(value * 100);
  if (Math.abs(cents - value * 100) > 0.0001) return null;
  return cents;
}

function formatAllocationDollars(cents) {
  return (cents / 100).toFixed(2);
}

module.exports = {
  formatAllocationDollars,
  parseStrictAllocationDollars,
};

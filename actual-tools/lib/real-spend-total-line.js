'use strict';

const c2 = (c) => (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (c) => (c < 0 ? '-$' : '$') + c2(c);

function monthReviewRealSpendTotalLine(grandCents, { incomplete = false } = {}) {
  if (incomplete) {
    return `### REAL SPEND TOTAL — INCOMPLETE known_lower_bound=${money(grandCents)} authoritative_total=UNAVAILABLE (transfer identity unresolved)`;
  }
  return `### REAL SPEND TOTAL: ${money(grandCents)}`;
}

module.exports = {
  monthReviewRealSpendTotalLine,
  money,
};

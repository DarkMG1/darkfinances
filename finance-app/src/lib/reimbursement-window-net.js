const { isKnownMoney } = require('./money-display.js');

/** Non-life window net requires both summary legs; absent either → unavailable (not zero). */
function reimbursementWindowNet(summary) {
  const fronted = summary?.fronted;
  const paidBack = summary?.paidBack;
  if (!isKnownMoney(fronted) || !isKnownMoney(paidBack)) return null;
  return paidBack - fronted;
}

module.exports = {
  reimbursementWindowNet,
};

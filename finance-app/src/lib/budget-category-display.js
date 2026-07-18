'use strict';

function categoryReserveUnavailable(category = {}) {
  return category.resolved === false || category.reserve == null;
}

function categoryReserveDisplay(category = {}) {
  if (categoryReserveUnavailable(category)) {
    return { kind: 'unavailable' };
  }
  return { kind: 'amount', dollars: category.reserve };
}

function categoryEnvelopeDebtDisplay(envelopeDebt) {
  if (envelopeDebt == null || envelopeDebt <= 0) {
    return { show: false, dollars: null };
  }
  return { show: true, dollars: envelopeDebt };
}

module.exports = {
  categoryReserveUnavailable,
  categoryReserveDisplay,
  categoryEnvelopeDebtDisplay,
};

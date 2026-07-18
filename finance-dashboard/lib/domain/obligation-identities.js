'use strict';

function recurringDurableIdentity(key) {
  return `recurring:${key}`;
}

function billDurableIdentity(key, dueDate) {
  return `bill:${key}|${dueDate}`;
}

function billSeriesDedupeGroup(key) {
  return `bill-series:${key}`;
}

function subscriptionSeriesDedupeGroup(key) {
  return `sub-series:${key}`;
}

function budgetDedupeGroup(categoryId) {
  return `budget:${categoryId}`;
}

function buildBillCategoryIndex(recurring = {}) {
  const byCategoryId = new Map();
  for (const item of [...(recurring.items || []), ...(recurring.hiddenItems || [])]) {
    if (!item.isBill || item.status !== 'active') continue;
    if (item.categoryId) byCategoryId.set(item.categoryId, item.key);
  }
  return { byCategoryId };
}

function billRecurringKeyForCategory(category, billIndex) {
  if (category.id && billIndex.byCategoryId.has(category.id)) {
    return billIndex.byCategoryId.get(category.id);
  }
  return null;
}

function isBillBackedCategory(category, billIndex) {
  return !!billRecurringKeyForCategory(category, billIndex);
}

module.exports = {
  billDurableIdentity,
  billSeriesDedupeGroup,
  budgetDedupeGroup,
  buildBillCategoryIndex,
  billRecurringKeyForCategory,
  isBillBackedCategory,
  recurringDurableIdentity,
  subscriptionSeriesDedupeGroup,
};

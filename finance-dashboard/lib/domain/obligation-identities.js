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
  const byCategoryName = new Map();
  for (const item of [...(recurring.items || []), ...(recurring.hiddenItems || [])]) {
    if (!item.isBill || item.status !== 'active') continue;
    if (item.categoryId) byCategoryId.set(item.categoryId, item.key);
    if (item.category) byCategoryName.set(String(item.category).toLowerCase(), item.key);
  }
  return { byCategoryId, byCategoryName };
}

function billRecurringKeyForCategory(category, billIndex) {
  if (category.id && billIndex.byCategoryId.has(category.id)) {
    return billIndex.byCategoryId.get(category.id);
  }
  const byName = billIndex.byCategoryName.get(String(category.name || '').toLowerCase());
  return byName || null;
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

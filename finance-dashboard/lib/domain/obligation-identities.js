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

function resolveRecurringCategoryIdentity({ override = {}, categoryIdCounts = {} } = {}) {
  if (typeof override.categoryId === 'string' && override.categoryId.trim()) {
    return { categoryId: override.categoryId.trim(), status: 'explicit' };
  }
  const ids = Object.entries(categoryIdCounts || {})
    .filter(([id, count]) => id && Number(count) > 0)
    .map(([id]) => id);
  if (ids.length === 1) return { categoryId: ids[0], status: 'inferred' };
  if (ids.length > 1) return { categoryId: null, status: 'ambiguous' };
  return { categoryId: null, status: 'missing' };
}

function buildBillCategoryIndex(recurring = {}) {
  const byCategoryId = new Map();
  for (const item of [...(recurring.items || []), ...(recurring.hiddenItems || [])]) {
    if (!item.isBill || item.status !== 'active') continue;
    if (!item.categoryId) continue;
    if (item.categoryIdentityStatus === 'ambiguous' || item.categoryIdentityStatus === 'missing') continue;
    byCategoryId.set(item.categoryId, item.key);
  }
  return { byCategoryId };
}

function collectBillCategoryIdentity(recurring = {}) {
  const billIndex = buildBillCategoryIndex(recurring);
  const issues = [];
  for (const item of [...(recurring.items || []), ...(recurring.hiddenItems || [])]) {
    if (item.status !== 'active' || !item.isBill) continue;
    const status = item.categoryIdentityStatus
      || (item.categoryId ? 'explicit' : 'missing');
    if (!item.categoryId || status === 'ambiguous' || status === 'missing') {
      issues.push({ key: item.key, status });
    }
  }
  return {
    billCategoryIds: [...billIndex.byCategoryId.keys()],
    billCategoryIdentityIssues: issues,
  };
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
  collectBillCategoryIdentity,
  isBillBackedCategory,
  recurringDurableIdentity,
  resolveRecurringCategoryIdentity,
  subscriptionSeriesDedupeGroup,
};

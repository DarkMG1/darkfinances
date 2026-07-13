#!/usr/bin/env node
const assert = require('assert/strict');
const path = require('path');

const demo = require(path.join(__dirname, '..', 'finance-dashboard', 'demoData'));

function fail(message) {
  console.error(`finance-fixtures: ${message}`);
  process.exit(1);
}

try {
  const accounts = demo.accounts();
  assert.ok(Array.isArray(accounts) && accounts.length >= 3, 'accounts');
  assert.ok(accounts.every((a) => a.id && typeof a.balance === 'number'), 'account shape');

  const categories = demo.categories();
  assert.ok(Array.isArray(categories) && categories.length >= 5, 'categories');

  const spending = demo.spending();
  assert.ok(spending && spending.current && typeof spending.current.totalSpend === 'number', 'spending');

  const review = demo.review();
  assert.ok(review && Array.isArray(review.tasks), 'review');

  const recurring = demo.recurring();
  assert.ok(recurring && Array.isArray(recurring.items), 'recurring');

  const reports = demo.reports();
  assert.ok(reports && reports.monthlyReview, 'reports');

  const today = demo.today();
  assert.ok(today && today.liquidity?.safeToSpend?.value !== undefined, 'today');
} catch (error) {
  fail(error.message || String(error));
}

console.log('finance-fixtures: ok');

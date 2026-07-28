'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  NOTIFICATION_ROUTES,
  parseNotificationRoute,
} = require('../src/lib/notification-reconcile');

const routerSource = fs.readFileSync(
  path.join(__dirname, '../src/components/notification-router.tsx'),
  'utf8',
);

const successCases = Object.entries(NOTIFICATION_ROUTES).map(([category, route]) => ({
  label: `${category} exact route`,
  input: { route, category, scope: 'server-abc123' },
  expected: { route, category, scope: 'server-abc123' },
}));

const rejectionCases = [
  {
    label: 'non-object payload',
    input: '/bills',
  },
  {
    label: 'missing scope',
    input: { route: NOTIFICATION_ROUTES.bills, category: 'bills' },
  },
  {
    label: 'empty scope',
    input: { route: NOTIFICATION_ROUTES.bills, category: 'bills', scope: '' },
  },
  {
    label: 'unknown category',
    input: { route: '/calendar', category: 'calendar', scope: 'server-a' },
  },
  {
    label: 'category/route mismatch',
    input: { route: NOTIFICATION_ROUTES.bills, category: 'weekly', scope: 'server-a' },
  },
  {
    label: 'route alias with query',
    input: { route: `${NOTIFICATION_ROUTES.bills}?x=1`, category: 'bills', scope: 'server-a' },
  },
  {
    label: 'route alias with fragment',
    input: { route: `${NOTIFICATION_ROUTES.repayments}#top`, category: 'repayments', scope: 'server-a' },
  },
  {
    label: 'encoded traversal segment',
    input: { route: '/%2e%2e/secret', category: 'bills', scope: 'server-a' },
  },
  {
    label: 'path traversal segment',
    input: { route: '/bills/../settings', category: 'bills', scope: 'server-a' },
  },
  {
    label: 'double-slash route',
    input: { route: '//bills', category: 'bills', scope: 'server-a' },
  },
  {
    label: 'relative route without leading slash',
    input: { route: 'bills', category: 'bills', scope: 'server-a' },
  },
  {
    label: 'non-string route',
    input: { route: 123, category: 'bills', scope: 'server-a' },
  },
  {
    label: 'non-string category',
    input: { route: NOTIFICATION_ROUTES.largeCharge, category: null, scope: 'server-a' },
  },
  {
    label: 'near-match largeCharge route',
    input: { route: '/(tabs)/transactions/extra', category: 'largeCharge', scope: 'server-a' },
  },
  {
    label: 'near-match weekly route',
    input: { route: '/review/extra', category: 'weekly', scope: 'server-a' },
  },
];

for (const successCase of successCases) {
  test(`parseNotificationRoute accepts ${successCase.label}`, () => {
    assert.deepEqual(parseNotificationRoute(successCase.input), successCase.expected);
  });
}

for (const rejectionCase of rejectionCases) {
  test(`parseNotificationRoute rejects ${rejectionCase.label}`, () => {
    assert.equal(parseNotificationRoute(rejectionCase.input), null);
  });
}

test('notification router navigates only parsed allowlisted routes', () => {
  assert.match(routerSource, /parseNotificationRoute\(data\)/);
  assert.match(routerSource, /router\.push\(payload\.route/);
  assert.doesNotMatch(routerSource, /router\.push\([^\)]*data\./);
  assert.doesNotMatch(routerSource, /payload\.route\.startsWith/);
});

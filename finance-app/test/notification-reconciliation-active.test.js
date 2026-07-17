const test = require('node:test');
const assert = require('node:assert/strict');
const { isNotificationReconciliationActive } = require('../src/lib/notification-reconciliation-active');

test('demo mode keeps notification reconciliation inert', () => {
  assert.equal(
    isNotificationReconciliationActive({
      configured: true,
      demo: true,
      notificationsCapable: true,
    }),
    false,
  );
});

test('free sideload builds keep notification reconciliation inert', () => {
  assert.equal(
    isNotificationReconciliationActive({
      configured: true,
      demo: false,
      notificationsCapable: false,
    }),
    false,
  );
});

test('unconfigured profiles keep notification reconciliation inert', () => {
  assert.equal(
    isNotificationReconciliationActive({
      configured: false,
      demo: false,
      notificationsCapable: true,
    }),
    false,
  );
});

test('configured full builds enable notification reconciliation', () => {
  assert.equal(
    isNotificationReconciliationActive({
      configured: true,
      demo: false,
      notificationsCapable: true,
    }),
    true,
  );
});

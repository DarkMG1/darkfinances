const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveReconcileEnabledSetting,
  SETTINGS_QUERY_EXCLUSION,
} = require('../src/lib/settings-query-display.js');

test('reconcile setting uses cached enabled value on refetch error', () => {
  const resolved = resolveReconcileEnabledSetting({
    isLoading: false,
    isError: true,
    data: { enabled: true },
  }, null);
  assert.equal(resolved.refetchError, true);
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.switchDisabled, false);
});

test('reconcile setting disables switch on fatal load without cached value', () => {
  const resolved = resolveReconcileEnabledSetting({
    isLoading: false,
    isError: true,
    data: undefined,
  }, null);
  assert.equal(resolved.fatalError, true);
  assert.equal(resolved.switchDisabled, true);
  assert.equal(resolved.enabled, false);
  assert.equal(resolved.misrepresentsWhenFatal, true);
});

test('settings inventory exclusion documents reconcile pending query', () => {
  assert.match(
    SETTINGS_QUERY_EXCLUSION.reason,
    /useReconcilePending/,
  );
  assert.equal(SETTINGS_QUERY_EXCLUSION.file, 'src/app/(tabs)/settings.tsx');
});

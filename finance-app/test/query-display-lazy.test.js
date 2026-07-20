const test = require('node:test');
const assert = require('node:assert/strict');
const {
  shouldShowFatalError,
  shouldShowInitialLoad,
  shouldInvokeQueryScreenContent,
} = require('../src/lib/query-display-state.js');

function display(query) {
  const data = query.data;
  return {
    data,
    initialLoad: shouldShowInitialLoad(!!query.isLoading, data),
    fatalError: shouldShowFatalError(!!query.isError, data),
    refetchError: !!query.isError && data != null,
  };
}

test('shouldInvokeQueryScreenContent blocks loading, fatal, empty, and undefined data', () => {
  assert.equal(shouldInvokeQueryScreenContent(display({ isLoading: true, data: undefined }), true), false);
  assert.equal(shouldInvokeQueryScreenContent(display({ isLoading: false, isError: true, data: undefined }), true), false);
  assert.equal(shouldInvokeQueryScreenContent(display({ isLoading: false, data: { ok: 1 } }), false), false);
  assert.equal(shouldInvokeQueryScreenContent(display({ isLoading: false, data: undefined }), true), false);
  assert.equal(shouldInvokeQueryScreenContent(display({ isLoading: false, data: { ok: 1 } }), true), true);
});

test('shouldInvokeQueryScreenContent allows cached payload during refetch error', () => {
  assert.equal(
    shouldInvokeQueryScreenContent(display({ isLoading: false, isError: true, data: { cached: 1 } }), true),
    true,
  );
});

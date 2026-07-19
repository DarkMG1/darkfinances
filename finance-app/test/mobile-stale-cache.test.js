const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  shouldShowInitialLoad,
  shouldShowFatalError,
  shouldShowRefetchError,
  isSearchQuerySettled,
} = require('../src/lib/query-display-state.js');
const {
  CONNECTION_SAVE_ACTIONS,
  connectionButtonControlState,
  connectionControlAccessibilityLabel,
  createSettingsConnectionSaveAdmission,
  disconnectButtonAccessibilityLabel,
  disconnectButtonVisibleLabel,
  isSettingsConnectionSaveBusy,
  releaseSettingsConnectionSave,
  resetSettingsConnectionLeaseCounter,
  runSettingsConnectionSave,
  settingsConnectionSaveSkippedMessage,
  tryAcquireSettingsConnectionSave,
} = require('../src/lib/settings-connection-save.js');
const { statCardAccessibilityLabel, heroMetricAccessibilityLabel } = require('../src/lib/metric-a11y.js');

const root = path.resolve(__dirname, '..');

function createBusyUi() {
  let busyOwner = null;
  return {
    hooks: {
      onAcquired: (lease, action = 'test') => { busyOwner = { lease, action }; },
      onReleased: (lease) => { if (busyOwner?.lease === lease) busyOwner = null; },
    },
    isBusy: () => busyOwner != null,
    owner: () => busyOwner,
    lease: () => busyOwner?.lease ?? null,
  };
}

test('query display keeps cached payload visible on refetch error', () => {
  const cached = { total: 42 };
  assert.equal(shouldShowInitialLoad(true, cached), false);
  assert.equal(shouldShowFatalError(true, cached), false);
  assert.equal(shouldShowRefetchError(true, cached), true);
  assert.equal(shouldShowFatalError(true, null), true);
  assert.equal(shouldShowInitialLoad(true, null), true);
});

test('query display treats empty arrays as cached data', () => {
  assert.equal(shouldShowFatalError(true, []), false);
  assert.equal(shouldShowRefetchError(true, []), true);
});

test('search query settlement avoids stale debounced mismatches', () => {
  assert.equal(isSearchQuerySettled('a', 'a'), true);
  assert.equal(isSearchQuerySettled('amazon', 'amaz'), false);
  assert.equal(isSearchQuerySettled('amazon', 'amazon'), true);
  assert.equal(isSearchQuerySettled('  amazon  ', 'amazon'), true);
  assert.equal(isSearchQuerySettled('a', ''), true);
});

test('settings connection save admission rejects concurrent verify/purge/setConfig', async () => {
  resetSettingsConnectionLeaseCounter();
  const admission = createSettingsConnectionSaveAdmission();
  let running = 0;
  let maxRunning = 0;
  const task = async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running -= 1;
    return 'ok';
  };

  const first = runSettingsConnectionSave(admission, task);
  const second = runSettingsConnectionSave(admission, task);
  const [a, b] = await Promise.all([first, second]);
  assert.equal([a, b].filter((o) => o.skipped).length, 1);
  assert.equal([a, b].filter((o) => o.ok).length, 1);
  assert.equal(maxRunning, 1);
  assert.equal(isSettingsConnectionSaveBusy(admission), false);
});

test('skipped double tap does not clear lease-owned busy UI', async () => {
  resetSettingsConnectionLeaseCounter();
  const admission = createSettingsConnectionSaveAdmission();
  const ui = createBusyUi();
  let releaseGate;
  const first = runSettingsConnectionSave(
    admission,
    () => new Promise((resolve) => { releaseGate = resolve; }),
    ui.hooks,
  );
  assert.equal(ui.isBusy(), true);
  const second = await runSettingsConnectionSave(admission, async () => 'never', ui.hooks);
  assert.equal(second.skipped, true);
  assert.equal(ui.isBusy(), true);
  releaseGate();
  await first;
  assert.equal(ui.isBusy(), false);
});

test('deferred first save keeps busy until owner finally releases', async () => {
  resetSettingsConnectionLeaseCounter();
  const admission = createSettingsConnectionSaveAdmission();
  const ui = createBusyUi();
  const events = [];
  let unblock;
  const pending = runSettingsConnectionSave(
    admission,
    () => new Promise((resolve) => { unblock = resolve; }),
    {
      onAcquired: (lease) => { ui.hooks.onAcquired(lease); events.push(`acquired:${lease}`); },
      onReleased: (lease) => { ui.hooks.onReleased(lease); events.push(`released:${lease}`); },
    },
  );
  assert.equal(ui.isBusy(), true);
  unblock();
  const outcome = await pending;
  assert.equal(outcome.ok, true);
  assert.equal(ui.isBusy(), false);
  assert.match(events.join(','), /acquired:1,released:1/);
});

test('disconnect during active save is skipped without clearing owner busy state', async () => {
  resetSettingsConnectionLeaseCounter();
  const admission = createSettingsConnectionSaveAdmission();
  const ui = createBusyUi();
  let finishSave;
  const save = runSettingsConnectionSave(
    admission,
    () => new Promise((resolve) => { finishSave = resolve; }),
    ui.hooks,
  );
  const disconnectAttempt = await runSettingsConnectionSave(
    admission,
    async () => { throw new Error('clear should not run'); },
    ui.hooks,
  );
  assert.equal(disconnectAttempt.skipped, true);
  assert.equal(ui.isBusy(), true);
  finishSave();
  await save;
  assert.equal(ui.isBusy(), false);
});

test('owner task failure still releases admission and busy UI in finally', async () => {
  resetSettingsConnectionLeaseCounter();
  const admission = createSettingsConnectionSaveAdmission();
  const ui = createBusyUi();
  const outcome = await runSettingsConnectionSave(
    admission,
    async () => { throw new Error('verify failed'); },
    ui.hooks,
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.skipped, false);
  assert.equal(outcome.error?.message, 'verify failed');
  assert.equal(isSettingsConnectionSaveBusy(admission), false);
  assert.equal(ui.isBusy(), false);
});

test('stale release callback cannot clear a newer lease owner', async () => {
  resetSettingsConnectionLeaseCounter();
  const admission = createSettingsConnectionSaveAdmission();
  const first = tryAcquireSettingsConnectionSave(admission);
  const second = tryAcquireSettingsConnectionSave(admission);
  assert.equal(first, 1);
  assert.equal(second, null);
  releaseSettingsConnectionSave(admission, 999);
  assert.equal(isSettingsConnectionSaveBusy(admission), true);
  releaseSettingsConnectionSave(admission, first);
  assert.equal(isSettingsConnectionSaveBusy(admission), false);
});

test('metric a11y helpers consolidate label/value/sub without duplication', () => {
  assert.equal(statCardAccessibilityLabel({ label: 'Spent', value: '$100.00', sub: '▲ 5% vs prev' }), 'Spent, $100.00, ▲ 5% vs prev');
  assert.equal(heroMetricAccessibilityLabel('Net worth', '$10,000.00', 'assets and liabilities'), 'Net worth, $10,000.00, assets and liabilities');
});

test('spending tab uses fatal error gate only when payload missing', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/(tabs)/spending.tsx'), 'utf8');
  assert.match(source, /shouldShowFatalError/);
  assert.match(source, /QueryRefetchBanners queries=\{spendingRefetchQueries\}/);
  assert.doesNotMatch(source, /spendingIsError\s*\?\s*\(/);
});

test('activity tab preserves cached list and settled search results', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/(tabs)/transactions.tsx'), 'utf8');
  assert.match(source, /isSearchQuerySettled/);
  assert.match(source, /shouldShowFatalError/);
  assert.match(source, /searchSettled/);
  assert.match(source, /QueryRefetchBanners queries=\{activityRefetchQueries\}/);
  assert.match(source, /categorizeAction\.isLocked/);
  assert.match(source, /openEventGroup/);
  assert.match(source, /if \(categorizeAction\.isLocked\) return;/);
  assert.match(source, /activity-event-row/);
  assert.doesNotMatch(source, /transactionsWindowKey/);
});

test('review navigation is gated while acknowledge mutation is locked', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/review.tsx'), 'utf8');
  assert.match(source, /if \(acknowledgeAction\.isLocked\) return;/);
  assert.match(source, /disabled={acknowledgeAction\.isLocked}/);
  assert.match(source, /if \(navLocked\) return/);
});

test('connection button controls use action-scoped spinner and unavailable labels', () => {
  const owner = { lease: 1, action: CONNECTION_SAVE_ACTIONS.TEST };
  const idle = connectionButtonControlState(CONNECTION_SAVE_ACTIONS.SAVE_URL, null);
  assert.equal(idle.showSpinner, false);
  assert.equal(idle.visibleLabel, 'Save URL');
  assert.equal(idle.accessibilityLabel, 'Save URL');

  const blocked = connectionButtonControlState(CONNECTION_SAVE_ACTIONS.SAVE_URL, owner);
  assert.equal(blocked.showSpinner, false);
  assert.equal(blocked.visibleLabel, 'Save URL');
  assert.equal(blocked.accessibilityLabel, 'Save URL unavailable while testing connection');

  const owns = connectionButtonControlState(CONNECTION_SAVE_ACTIONS.SAVE_URL, { lease: 2, action: CONNECTION_SAVE_ACTIONS.SAVE_URL });
  assert.equal(owns.showSpinner, true);
  assert.equal(owns.busy, true);
  assert.equal(owns.accessibilityLabel, 'Saving server URL');
});

test('every connection save action exposes idle, in-progress, and blocked-unavailable labels', () => {
  const actions = Object.values(CONNECTION_SAVE_ACTIONS);
  const blocker = { lease: 99, action: CONNECTION_SAVE_ACTIONS.TEST };
  for (const action of actions) {
    const idle = connectionControlAccessibilityLabel(action, null);
    const inProgress = connectionControlAccessibilityLabel(action, { lease: 1, action });
    assert.ok(idle.length > 0, `${action} idle label`);
    assert.ok(inProgress.length > 0, `${action} in-progress label`);
    assert.notEqual(idle, inProgress, `${action} in-progress differs from idle`);
    if (action !== CONNECTION_SAVE_ACTIONS.TEST) {
      const blocked = connectionControlAccessibilityLabel(action, blocker);
      assert.match(blocked, /unavailable while testing connection/);
    }
  }
});

test('disconnect visible label only changes while disconnect owns admission', () => {
  assert.equal(disconnectButtonVisibleLabel(null), 'Disconnect');
  assert.equal(disconnectButtonVisibleLabel({ lease: 1, action: CONNECTION_SAVE_ACTIONS.SAVE_URL }), 'Disconnect');
  assert.equal(disconnectButtonVisibleLabel({ lease: 2, action: CONNECTION_SAVE_ACTIONS.DISCONNECT }), 'Disconnecting…');
  assert.equal(
    disconnectButtonAccessibilityLabel({ lease: 1, action: CONNECTION_SAVE_ACTIONS.SAVE_URL }),
    'Disconnect unavailable while saving server URL',
  );
});

test('skipped connection save exposes deterministic user-facing message', () => {
  assert.match(
    settingsConnectionSaveSkippedMessage(CONNECTION_SAVE_ACTIONS.DISCONNECT),
    /Could not disconnect/,
  );
  assert.match(
    settingsConnectionSaveSkippedMessage(CONNECTION_SAVE_ACTIONS.FACE_ID),
    /Face ID lock/,
  );
});

test('face id flow keeps admission lease held through authenticate prompt', async () => {
  resetSettingsConnectionLeaseCounter();
  const admission = createSettingsConnectionSaveAdmission();
  const ui = createBusyUi();
  let authStarted = false;
  let unblockAuth;
  const pending = runSettingsConnectionSave(
    admission,
    async () => {
      authStarted = true;
      assert.equal(ui.isBusy(), true);
      assert.equal(ui.owner()?.action, CONNECTION_SAVE_ACTIONS.FACE_ID);
      await new Promise((resolve) => { unblockAuth = resolve; });
      return 'saved';
    },
    {
      onAcquired: (lease) => ui.hooks.onAcquired(lease, CONNECTION_SAVE_ACTIONS.FACE_ID),
      onReleased: ui.hooks.onReleased,
    },
  );
  assert.equal(ui.isBusy(), true);
  assert.equal(authStarted, true);
  unblockAuth();
  await pending;
  assert.equal(ui.isBusy(), false);
});

test('stale disconnect confirm reports skipped message instead of silent no-op', async () => {
  resetSettingsConnectionLeaseCounter();
  const admission = createSettingsConnectionSaveAdmission();
  let finishSave;
  const save = runSettingsConnectionSave(
    admission,
    () => new Promise((resolve) => { finishSave = resolve; }),
    { onAcquired: (lease) => {}, onReleased: () => {} },
  );
  const skipped = await runSettingsConnectionSave(
    admission,
    async () => { throw new Error('clear should not run'); },
    { onAcquired: (lease) => {}, onReleased: () => {} },
  );
  assert.equal(skipped.skipped, true);
  assert.match(
    settingsConnectionSaveSkippedMessage(CONNECTION_SAVE_ACTIONS.DISCONNECT),
    /Try again shortly/,
  );
  finishSave();
  await save;
});

test('settings profile-changing actions share lease-owned admission guard', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/(tabs)/settings.tsx'), 'utf8');
  assert.match(source, /createSettingsConnectionSaveAdmission/);
  assert.match(source, /runSettingsConnectionSave/);
  assert.match(source, /onAcquired/);
  assert.match(source, /onReleased/);
  assert.match(source, /busyOwner/);
  assert.match(source, /connectionButtonControlState/);
  assert.match(source, /saveUrlControl\.showSpinner/);
  assert.match(source, /saveUrlControl\.visibleLabel/);
  assert.match(source, /testControl\.accessibilityLabel/);
  assert.match(source, /settingsConnectionSaveSkippedMessage/);
  assert.match(source, /announceConnectionStatus\('Face ID lock not enabled'\)/);
  assert.match(source, /announceConnectionStatus\(value \? 'Face ID lock enabled'/);
  assert.match(source, /CONNECTION_SAVE_ACTIONS\.DISCONNECT/);
  assert.match(source, /CONNECTION_SAVE_ACTIONS\.FACE_ID/);
  assert.match(source, /await authenticate\('Enable Face ID lock'\)/);
  assert.match(source, /await setConfig\(verified\)/);
  assert.match(source, /await clear\(\)/);
  assert.match(source, /disconnectButtonVisibleLabel\(busyOwner\)/);
  assert.doesNotMatch(source, /connectionBusy \? 'Disconnecting/);
  assert.doesNotMatch(source, /connectionBusy \? <ActivityIndicator/);
  assert.match(source, /connectionSwitchAccessibilityLabel/);
});

test('reimbursement range chips disable while confirm/dismiss in flight', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/reimbursement.tsx'), 'utf8');
  assert.match(source, /disabled={rangeLocked}/);
  assert.match(source, /const rangeLocked = banner\.isLocked/);
});

test('StatCard exposes one consolidated accessibility label', () => {
  const source = fs.readFileSync(path.join(root, 'src/components/ui.tsx'), 'utf8');
  assert.match(source, /accessibilityElementsHidden/);
  assert.match(source, /accessible accessibilityLabel={a11yLabel}/);
});

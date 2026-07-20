const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHECK_SOURCES,
  DEFAULT_DEFER_COOLDOWN_MS,
  DEFAULT_CHECK_THROTTLE_MS,
  OTA_UPDATE_PHASES,
  createInitialOtaUpdateState,
  getOtaUpdateDisplayStatus,
  getOtaUpdateStatusLabel,
  reduceOtaUpdateState,
  shouldPrompt,
} = require('../src/lib/ota-update-state');

const NOW = 1_700_000_000_000;
const UPDATE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const UPDATE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function reduce(state, event, options = {}) {
  return reduceOtaUpdateState(state, event, { now: NOW, ...options });
}

test('unsupported builds stay unsupported and never enter checking', () => {
  const state = createInitialOtaUpdateState({ supported: false });
  assert.equal(state.phase, OTA_UPDATE_PHASES.UNSUPPORTED);
  const next = reduce(state, { type: 'auto_check_requested', lastAutoCheckAt: 0 });
  assert.equal(next.phase, OTA_UPDATE_PHASES.UNSUPPORTED);
});

test('native pending on startup enters downloaded without checking', () => {
  const state = createInitialOtaUpdateState({
    supported: true,
    nativePending: true,
    updateId: UPDATE_A,
    now: NOW,
  });
  assert.equal(state.phase, OTA_UPDATE_PHASES.DOWNLOADED);
  assert.equal(state.updateId, UPDATE_A);
});

test('check to download to downloaded follows explicit phases', () => {
  let state = createInitialOtaUpdateState({ supported: true });
  state = reduce(state, { type: 'auto_check_requested', lastAutoCheckAt: 0 });
  assert.equal(state.phase, OTA_UPDATE_PHASES.CHECKING);
  state = reduce(state, {
    type: 'check_succeeded',
    isAvailable: true,
    updateId: UPDATE_A,
    deferredRecord: null,
  });
  assert.equal(state.phase, OTA_UPDATE_PHASES.AVAILABLE);
  state = reduce(state, { type: 'download_started' });
  assert.equal(state.phase, OTA_UPDATE_PHASES.DOWNLOADING);
  state = reduce(state, {
    type: 'download_succeeded',
    updateId: UPDATE_A,
    deferredRecord: null,
  });
  assert.equal(state.phase, OTA_UPDATE_PHASES.DOWNLOADED);
});

test('Later binds cooldown to update identity and a second update id is not suppressed', () => {
  let state = createInitialOtaUpdateState({ supported: true });
  state = {
    phase: OTA_UPDATE_PHASES.DOWNLOADED,
    updateId: UPDATE_A,
    checkSource: null,
    error: null,
    manualStatus: null,
    promptedUpdateId: null,
    deferredUntil: null,
  };
  state = reduce(state, {
    type: 'prompt_ready',
    appActive: true,
    promptGateOpen: true,
  });
  assert.equal(state.phase, OTA_UPDATE_PHASES.PROMPTED);
  state = reduce(state, { type: 'prompt_deferred' }, { deferCooldownMs: DEFAULT_DEFER_COOLDOWN_MS });
  assert.equal(state.phase, OTA_UPDATE_PHASES.DEFERRED);
  assert.equal(state.deferredUntil, NOW + DEFAULT_DEFER_COOLDOWN_MS);

  state = reduce(state, {
    type: 'auto_check_requested',
    lastAutoCheckAt: NOW - DEFAULT_CHECK_THROTTLE_MS,
  }, { now: NOW, checkThrottleMs: DEFAULT_CHECK_THROTTLE_MS });
  assert.equal(state.phase, OTA_UPDATE_PHASES.CHECKING);

  state = reduce(state, {
    type: 'check_succeeded',
    isAvailable: true,
    updateId: UPDATE_A,
    deferredRecord: { updateId: UPDATE_A, deferredUntil: NOW + DEFAULT_DEFER_COOLDOWN_MS },
  }, { now: NOW });
  assert.equal(state.phase, OTA_UPDATE_PHASES.DEFERRED);

  state = reduce(state, { type: 'manual_check_requested' }, { now: NOW + DEFAULT_DEFER_COOLDOWN_MS + 1 });
  state = reduce(state, {
    type: 'check_succeeded',
    isAvailable: true,
    updateId: UPDATE_B,
    deferredRecord: { updateId: UPDATE_A, deferredUntil: NOW + DEFAULT_DEFER_COOLDOWN_MS },
  }, { now: NOW + DEFAULT_DEFER_COOLDOWN_MS + 1 });
  assert.equal(state.phase, OTA_UPDATE_PHASES.AVAILABLE);
  assert.equal(state.updateId, UPDATE_B);
});

test('prompt waits for privacy gate and active app state', () => {
  const downloaded = {
    phase: OTA_UPDATE_PHASES.DOWNLOADED,
    updateId: UPDATE_A,
    checkSource: null,
    error: null,
    manualStatus: null,
    promptedUpdateId: null,
    deferredUntil: null,
  };
  assert.equal(shouldPrompt(downloaded, { appActive: true, promptGateOpen: false, now: NOW }), false);
  assert.equal(shouldPrompt(downloaded, { appActive: false, promptGateOpen: true, now: NOW }), false);
  assert.equal(shouldPrompt(downloaded, { appActive: true, promptGateOpen: true, now: NOW }), true);
  assert.equal(shouldPrompt({
    ...downloaded,
    promptedUpdateId: UPDATE_A,
  }, { appActive: true, promptGateOpen: true, now: NOW }), false);
});

test('errors recover to manual retry and auto throttle resets after failure', () => {
  let state = createInitialOtaUpdateState({ supported: true });
  state = reduce(state, { type: 'manual_check_requested' });
  state = reduce(state, { type: 'check_failed', message: 'offline' });
  assert.equal(state.phase, OTA_UPDATE_PHASES.ERROR);
  assert.match(state.manualStatus, /offline/);

  state = reduce(state, { type: 'manual_check_requested' });
  assert.equal(state.phase, OTA_UPDATE_PHASES.CHECKING);
  assert.equal(state.checkSource, CHECK_SOURCES.MANUAL);
});

test('auto foreground checks honor throttle window', () => {
  const state = createInitialOtaUpdateState({ supported: true });
  const blocked = reduce(state, {
    type: 'auto_check_requested',
    lastAutoCheckAt: NOW - 5_000,
  }, { checkThrottleMs: DEFAULT_CHECK_THROTTLE_MS, now: NOW });
  assert.equal(blocked.phase, OTA_UPDATE_PHASES.IDLE);

  const allowed = reduce(state, {
    type: 'auto_check_requested',
    lastAutoCheckAt: NOW - DEFAULT_CHECK_THROTTLE_MS,
  }, { checkThrottleMs: DEFAULT_CHECK_THROTTLE_MS, now: NOW });
  assert.equal(allowed.phase, OTA_UPDATE_PHASES.CHECKING);
});

test('restart is only accepted from prompted state', () => {
  let state = {
    phase: OTA_UPDATE_PHASES.DOWNLOADED,
    updateId: UPDATE_A,
    checkSource: null,
    error: null,
    manualStatus: null,
    promptedUpdateId: null,
    deferredUntil: null,
  };
  state = reduce(state, { type: 'restart_requested' });
  assert.equal(state.phase, OTA_UPDATE_PHASES.DOWNLOADED);

  state = reduce(state, {
    type: 'prompt_ready',
    appActive: true,
    promptGateOpen: true,
  });
  state = reduce(state, { type: 'restart_requested' });
  assert.equal(state.phase, OTA_UPDATE_PHASES.RESTARTING);
});

test('status labels track live owner phases for settings display', () => {
  assert.equal(getOtaUpdateStatusLabel({ phase: OTA_UPDATE_PHASES.CHECKING }), 'Checking…');
  assert.equal(getOtaUpdateStatusLabel({ phase: OTA_UPDATE_PHASES.DOWNLOADING }), 'Downloading update…');
  assert.equal(
    getOtaUpdateDisplayStatus({ phase: OTA_UPDATE_PHASES.ERROR, error: 'offline' }),
    'offline',
  );
});

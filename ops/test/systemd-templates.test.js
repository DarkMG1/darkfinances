'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadWriterInventory, enumerateWriters } = require('../lib/writer-inventory');
const { checkSystemdUnits } = require('../../scripts/check-systemd');

const repoRoot = path.resolve(__dirname, '..', '..');
const systemdDir = path.join(repoRoot, 'ops/systemd');
const dashboardUnitPath = path.join(systemdDir, 'finance-dashboard.service');
const eventSyncServicePath = path.join(systemdDir, 'finance-event-sync.service');
const eventSyncTimerPath = path.join(systemdDir, 'finance-event-sync.timer');

const FINANCE_SHUTDOWN_HARD_CAP_SEC = 15;
const SYSTEMD_STOP_MARGIN_SEC = 10;
const EXPECTED_TIMEOUT_STOP_SEC = FINANCE_SHUTDOWN_HARD_CAP_SEC + SYSTEMD_STOP_MARGIN_SEC;

function readUnit(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function parseDirective(unitText, directive) {
  const match = unitText.match(new RegExp(`^${directive}=(.+)$`, 'm'));
  return match ? match[1].trim() : null;
}

test('finance-dashboard.service TimeoutStopSec matches graceful-shutdown hard cap plus margin', () => {
  const unitText = readUnit('ops/systemd/finance-dashboard.service');
  const timeoutStopSec = parseDirective(unitText, 'TimeoutStopSec');
  assert.equal(timeoutStopSec, String(EXPECTED_TIMEOUT_STOP_SEC));
  assert.ok(
    EXPECTED_TIMEOUT_STOP_SEC >= FINANCE_SHUTDOWN_HARD_CAP_SEC + 5,
    'TimeoutStopSec must exceed app hard cap with margin',
  );
  assert.ok(
    EXPECTED_TIMEOUT_STOP_SEC <= 30,
    'TimeoutStopSec must stay within documented 20-30s contract band',
  );
  assert.match(
    unitText,
    /FINANCE_SHUTDOWN_TIMEOUT_MS defaults to 15s/,
    'unit file must document the app hard-cap alignment',
  );
});

test('finance-dashboard.service loads deployment secrets from EnvironmentFile', () => {
  const unitText = readUnit('ops/systemd/finance-dashboard.service');
  assert.equal(parseDirective(unitText, 'EnvironmentFile'), '%h/.openclaw/finance-dashboard.env');
  assert.match(
    unitText,
    /EnvironmentFile=%h\/\.openclaw\/finance-dashboard\.env/,
    'production dashboard must load RELEASE_KEYRING_PATH and other secrets from EnvironmentFile',
  );
});

test('finance-dashboard.service pins production runtime mode without test-only bypass flags', () => {
  const unitText = readUnit('ops/systemd/finance-dashboard.service');
  const environmentDirectives = [...unitText.matchAll(/^Environment=(.+)$/mg)].map((match) => match[1].trim());
  assert.deepEqual(environmentDirectives, [
    'FINANCE_RUNTIME_MODE=production',
    'NODE_ENV=production',
  ]);
  assert.doesNotMatch(unitText, /ALLOW_RAW_ACTUAL_API/);
  assert.doesNotMatch(unitText, /SELFTEST/);
  assert.doesNotMatch(unitText, /TEST_SERVER_INSTANCE_ID/);
  assert.doesNotMatch(unitText, /FINANCE_QUERY_TEST_/);
  assert.doesNotMatch(unitText, /NODE_ENV=test/);
  assert.doesNotMatch(unitText, /FINANCE_RUNTIME_MODE=test/);
});

test('finance-dashboard.service path is exercised by check:systemd', () => {
  assert.equal(fs.existsSync(dashboardUnitPath), true);
});

test('finance-event-sync units exist on disk', () => {
  assert.equal(fs.existsSync(eventSyncServicePath), true);
  assert.equal(fs.existsSync(eventSyncTimerPath), true);
});

test('finance-event-sync.service uses safe oneshot semantics with Pacific TZ, private umask, and failure alert', () => {
  const unitText = readUnit('ops/systemd/finance-event-sync.service');
  assert.equal(parseDirective(unitText, 'Type'), 'oneshot');
  assert.equal(parseDirective(unitText, 'UMask'), '0077');
  assert.equal(parseDirective(unitText, 'Environment'), 'TZ=America/Los_Angeles');
  assert.equal(parseDirective(unitText, 'OnFailure'), 'finance-sync-failure@%n.service');
  assert.equal(
    parseDirective(unitText, 'ExecStart'),
    '/usr/bin/bash %h/actual-tools/run.sh owes-snapshot.js',
  );
  assert.doesNotMatch(unitText, /^Restart=/m, 'oneshot snapshot job must not auto-restart');
});

test('finance-event-sync.timer matches half-hour Pacific cadence replacing */30 cron', () => {
  const unitText = readUnit('ops/systemd/finance-event-sync.timer');
  assert.equal(parseDirective(unitText, 'OnCalendar'), '*-*-* *:00/30:00 America/Los_Angeles');
  assert.equal(parseDirective(unitText, 'Persistent'), 'true');
  assert.equal(parseDirective(unitText, 'RandomizedDelaySec'), '120');
  assert.equal(parseDirective(unitText, 'Unit'), 'finance-event-sync.service');
  assert.match(unitText, /^WantedBy=timers\.target$/m);
});

test('writer inventory finance-event-sync entries correspond to checked-in systemd units', () => {
  const inventory = loadWriterInventory();
  const eventWriters = inventory.writers.filter((writer) => writer.component === 'finance-event-sync');
  assert.equal(eventWriters.length, 2);

  const timerWriter = eventWriters.find((writer) => writer.type === 'systemd-timer');
  const serviceWriter = eventWriters.find((writer) => writer.type === 'systemd-service');
  assert.ok(timerWriter);
  assert.ok(serviceWriter);
  assert.equal(timerWriter.unit, 'finance-event-sync.timer');
  assert.equal(serviceWriter.unit, 'finance-event-sync.service');
  assert.equal(timerWriter.configEnv, 'FINANCE_EVENT_SYNC_CONFIGURED');
  assert.equal(serviceWriter.configEnv, 'FINANCE_EVENT_SYNC_CONFIGURED');
  assert.equal(timerWriter.optional, true);
  assert.equal(serviceWriter.optional, true);

  for (const writer of eventWriters) {
    const unitPath = path.join(systemdDir, writer.unit);
    assert.equal(fs.existsSync(unitPath), true, `${writer.unit} must exist for inventory ${writer.id}`);
  }
});

test('enumerateWriters gates finance-event-sync on FINANCE_EVENT_SYNC_CONFIGURED', () => {
  const inventory = loadWriterInventory();
  const withoutFlag = enumerateWriters(inventory, {});
  const withFlag = enumerateWriters(inventory, { FINANCE_EVENT_SYNC_CONFIGURED: '1' });

  assert.equal(
    withoutFlag.some((writer) => writer.id === 'finance-event-sync.timer'),
    false,
  );
  assert.equal(
    withoutFlag.some((writer) => writer.id === 'finance-event-sync.service'),
    false,
  );
  assert.equal(
    withFlag.some((writer) => writer.id === 'finance-event-sync.timer'),
    true,
  );
  assert.equal(
    withFlag.some((writer) => writer.id === 'finance-event-sync.service'),
    true,
  );
});

const PRIVATE_CONTEXT_SERVICE_UNITS = fs
  .readdirSync(systemdDir)
  .filter((name) => name.endsWith('.service'))
  .sort();

test('every checked-in service unit handling private context sets UMask=0077', () => {
  assert.deepEqual(PRIVATE_CONTEXT_SERVICE_UNITS, [
    'actual-sync.service',
    'finance-dashboard.service',
    'finance-event-sync.service',
    'finance-sync-failure@.service',
  ]);

  for (const unitName of PRIVATE_CONTEXT_SERVICE_UNITS) {
    const unitText = readUnit(path.join('ops/systemd', unitName));
    assert.equal(
      parseDirective(unitText, 'UMask'),
      '0077',
      `${unitName} must set UMask=0077 for private file creation`,
    );
  }
});

test('finance-sync-failure@.service uses private umask for alert bridge', () => {
  const unitText = readUnit('ops/systemd/finance-sync-failure@.service');
  assert.equal(parseDirective(unitText, 'Type'), 'oneshot');
  assert.equal(parseDirective(unitText, 'UMask'), '0077');
  assert.equal(parseDirective(unitText, 'Environment'), 'TZ=America/Los_Angeles');
  assert.equal(parseDirective(unitText, 'ExecStart'), '%h/.local/bin/finance-sync-alert.sh %i');
});

test('systemd verifier replaces deployment executable paths with executable fixtures', () => {
  let inspectedVerifyCall = false;
  const result = checkSystemdUnits({
    spawnSync(command, args) {
      assert.equal(command, 'systemd-analyze');
      if (args[0] === '--version') return { status: 0, stdout: '', stderr: '' };

      assert.deepEqual(args.slice(0, 2), ['--user', 'verify']);
      const units = new Map(args.slice(2).map((unitPath) => [
        path.basename(unitPath),
        fs.readFileSync(unitPath, 'utf8'),
      ]));
      const dashboardExec = parseDirective(units.get('finance-dashboard.service'), 'ExecStart');
      const eventSyncExec = parseDirective(units.get('finance-event-sync.service'), 'ExecStart');
      assert.doesNotMatch(dashboardExec, /^\/usr\/bin\/node\b/);
      assert.doesNotMatch(eventSyncExec, /^\/usr\/bin\/bash\b/);
      fs.accessSync(dashboardExec.split(' ', 1)[0], fs.constants.X_OK);
      fs.accessSync(eventSyncExec.split(' ', 1)[0], fs.constants.X_OK);
      inspectedVerifyCall = true;
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.skipped, false);
  assert.equal(inspectedVerifyCall, true);
});

test('checked-in systemd units pass systemd-analyze verify when available', (t) => {
  const result = checkSystemdUnits();
  if (result.skipped) {
    t.skip(result.reason);
    return;
  }
  const expectedUnitCount = fs.readdirSync(systemdDir)
    .filter((name) => name.endsWith('.service') || name.endsWith('.timer'))
    .length;
  assert.equal(result.unitCount, expectedUnitCount);
});

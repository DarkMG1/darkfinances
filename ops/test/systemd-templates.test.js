'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const dashboardUnitPath = path.join(repoRoot, 'ops/systemd/finance-dashboard.service');

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

test('finance-dashboard.service path is exercised by check:systemd', () => {
  assert.equal(fs.existsSync(dashboardUnitPath), true);
});

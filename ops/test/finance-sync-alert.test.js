'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const alertScript = path.join(repoRoot, 'ops/bin/finance-sync-alert.sh');

function mkRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function installOpenclawStub(root, capturePath) {
  const binDir = path.join(root, '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const stubPath = path.join(binDir, 'openclaw');
  const body = `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "cron" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '{"jobs":[{"name":"finance-morning","delivery":{"to":"telegram:123"}}]}'
  exit 0
fi
if [ "$1" = "message" ]; then
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--message" ] && [ -n "\${2:-}" ]; then
      printf '%s' "$2" > ${JSON.stringify(capturePath)}
      exit 0
    fi
    shift
  done
fi
exit 1
`;
  fs.writeFileSync(stubPath, body, { mode: 0o755 });
  return binDir;
}

function runAlert(root, unit) {
  const capturePath = path.join(root, 'alert-message.txt');
  const binDir = installOpenclawStub(root, capturePath);
  const result = spawnSync('bash', [alertScript, unit], {
    env: {
      ...process.env,
      HOME: root,
      ALERT_DRY_RUN: '1',
    },
    encoding: 'utf8',
  });
  return {
    result,
    message: fs.existsSync(capturePath) ? fs.readFileSync(capturePath, 'utf8') : '',
  };
}

test('finance-sync-alert.sh reports bank transaction staleness for actual-sync.service', (t) => {
  const root = mkRoot(t, 'df-alert-bank-');
  const { result, message } = runAlert(root, 'actual-sync.service');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(message, /actual-sync\.service failed/);
  assert.match(message, /Bank transactions may be stale/);
  assert.doesNotMatch(message, /Who-owes snapshot/);
});

test('finance-sync-alert.sh reports snapshot staleness for finance-event-sync.service', (t) => {
  const root = mkRoot(t, 'df-alert-event-');
  const { result, message } = runAlert(root, 'finance-event-sync.service');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(message, /finance-event-sync\.service failed/);
  assert.match(message, /Who-owes snapshot data may be stale/);
  assert.match(message, /Splitwise reimbursement balances/);
  assert.doesNotMatch(message, /Bank transactions may be stale/);
});

test('finance-sync-alert.sh uses generic impact text for unknown units', (t) => {
  const root = mkRoot(t, 'df-alert-generic-');
  const { result, message } = runAlert(root, 'custom-job.service');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(message, /custom-job\.service failed/);
  assert.match(message, /scheduled finance job may not have completed successfully/);
});

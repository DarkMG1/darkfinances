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

function installOpenclawStub(root) {
  const binDir = path.join(root, '.local', 'bin');
  const npmGlobalBin = path.join(root, '.npm-global', 'bin');
  const capturePath = path.join(root, 'alert-message.txt');
  const dryRunPath = path.join(root, 'alert-dry-run.txt');
  const invocationsPath = path.join(root, 'openclaw-invocations.txt');
  const messageArgsPath = path.join(root, 'openclaw-message-args.txt');
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(npmGlobalBin, { recursive: true, mode: 0o700 });
  const nodeLink = path.join(npmGlobalBin, 'node');
  if (!fs.existsSync(nodeLink)) {
    fs.symlinkSync(process.execPath, nodeLink);
  }
  const stubPath = path.join(binDir, 'openclaw');
  const body = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$1" >> ${JSON.stringify(invocationsPath)}
if [ "$1" = "cron" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '{"jobs":[{"name":"finance-morning","delivery":{"to":"telegram:123"}}]}'
  exit 0
fi
if [ "$1" = "message" ]; then
  shift
  : > ${JSON.stringify(messageArgsPath)}
  saw_dry_run=0
  message_value=""
  while [ "$#" -gt 0 ]; do
    printf '%s\\n' "$1" >> ${JSON.stringify(messageArgsPath)}
    if [ "$1" = "--dry-run" ]; then
      saw_dry_run=1
      shift
    elif [ "$1" = "--message" ] && [ -n "\${2:-}" ]; then
      message_value="$2"
      shift 2
    else
      shift
    fi
  done
  if [ -n "$message_value" ]; then
    if [ "$saw_dry_run" = "1" ]; then
      printf '%s' "$message_value" > ${JSON.stringify(dryRunPath)}
    else
      printf '%s' "$message_value" > ${JSON.stringify(capturePath)}
    fi
    exit 0
  fi
fi
exit 1
`;
  fs.writeFileSync(stubPath, body, { mode: 0o755 });
  return { binDir, capturePath, dryRunPath, invocationsPath, messageArgsPath };
}

function readMessageArgs(root) {
  const messageArgsPath = path.join(root, 'openclaw-message-args.txt');
  if (!fs.existsSync(messageArgsPath)) {
    return [];
  }
  return fs.readFileSync(messageArgsPath, 'utf8').split('\n').filter(Boolean);
}

function runAlert(root, args, envOverrides = {}) {
  installOpenclawStub(root);
  const capturePath = path.join(root, 'alert-message.txt');
  const dryRunPath = path.join(root, 'alert-dry-run.txt');
  const invocationsPath = path.join(root, 'openclaw-invocations.txt');
  const result = spawnSync('bash', [alertScript, ...args], {
    env: {
      HOME: root,
      ALERT_DRY_RUN: '0',
      PATH: '/usr/bin:/bin',
      ...envOverrides,
    },
    encoding: 'utf8',
  });
  return {
    result,
    message: fs.existsSync(capturePath) ? fs.readFileSync(capturePath, 'utf8') : '',
    dryRunMessage: fs.existsSync(dryRunPath) ? fs.readFileSync(dryRunPath, 'utf8') : '',
    invocations: fs.existsSync(invocationsPath) ? fs.readFileSync(invocationsPath, 'utf8') : '',
    messageArgs: readMessageArgs(root),
  };
}

function assertMessageArgvHasDryRun(messageArgs) {
  assert.ok(messageArgs.includes('--dry-run'), 'expected standalone --dry-run in message argv');
}

function assertMessageArgvLiveSend(messageArgs) {
  assert.ok(messageArgs.length > 0, 'expected message argv');
  assert.ok(!messageArgs.includes('--dry-run'), 'expected no --dry-run in message argv');
}

function assertDryRunOnly(t, run) {
  assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
  assert.equal(run.message, '', 'expected no live message send');
  assert.notEqual(run.dryRunMessage, '', 'expected dry-run message preview');
  assertMessageArgvHasDryRun(run.messageArgs);
}

function assertLiveSendOnly(t, run) {
  assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
  assert.notEqual(run.message, '', 'expected live message send');
  assert.equal(run.dryRunMessage, '', 'expected no dry-run message preview');
  assertMessageArgvLiveSend(run.messageArgs);
}

function assertNoOpenclaw(t, run, expectedStatus = 2) {
  assert.equal(run.result.status, expectedStatus, run.result.stderr || run.result.stdout);
  assert.equal(run.message, '', 'expected no live message send');
  assert.equal(run.dryRunMessage, '', 'expected no dry-run message preview');
  assert.equal(run.invocations, '', 'expected zero openclaw invocations');
  assert.equal(run.messageArgs.length, 0, 'expected zero message argv');
}

test('finance-sync-alert.sh reports bank transaction staleness for actual-sync.service', (t) => {
  const root = mkRoot(t, 'df-alert-bank-');
  const run = runAlert(root, ['actual-sync.service'], { ALERT_DRY_RUN: '1' });
  assertDryRunOnly(t, run);
  assert.match(run.dryRunMessage, /actual-sync\.service failed/);
  assert.match(run.dryRunMessage, /Bank transactions may be stale/);
  assert.doesNotMatch(run.dryRunMessage, /Who-owes snapshot/);
});

test('finance-sync-alert.sh reports snapshot staleness for finance-event-sync.service', (t) => {
  const root = mkRoot(t, 'df-alert-event-');
  const run = runAlert(root, ['finance-event-sync.service'], { ALERT_DRY_RUN: '1' });
  assertDryRunOnly(t, run);
  assert.match(run.dryRunMessage, /finance-event-sync\.service failed/);
  assert.match(run.dryRunMessage, /Who-owes snapshot data may be stale/);
  assert.match(run.dryRunMessage, /Splitwise reimbursement balances/);
  assert.doesNotMatch(run.dryRunMessage, /Bank transactions may be stale/);
});

test('finance-sync-alert.sh uses generic impact text for unknown units', (t) => {
  const root = mkRoot(t, 'df-alert-generic-');
  const run = runAlert(root, ['custom-job.service'], { ALERT_DRY_RUN: '1' });
  assertDryRunOnly(t, run);
  assert.match(run.dryRunMessage, /custom-job\.service failed/);
  assert.match(run.dryRunMessage, /scheduled finance job may not have completed successfully/);
});

test('finance-sync-alert.sh --dry-run before unit forwards OpenClaw dry-run without live send', (t) => {
  const root = mkRoot(t, 'df-alert-cli-before-');
  const run = runAlert(root, ['--dry-run', 'actual-sync.service']);
  assertDryRunOnly(t, run);
  assert.match(run.dryRunMessage, /actual-sync\.service failed/);
  assert.match(run.dryRunMessage, /Bank transactions may be stale/);
});

test('finance-sync-alert.sh --dry-run after unit forwards OpenClaw dry-run without live send', (t) => {
  const root = mkRoot(t, 'df-alert-cli-after-');
  const run = runAlert(root, ['finance-event-sync.service', '--dry-run']);
  assertDryRunOnly(t, run);
  assert.match(run.dryRunMessage, /finance-event-sync\.service failed/);
  assert.match(run.dryRunMessage, /Who-owes snapshot data may be stale/);
});

test('finance-sync-alert.sh ALERT_DRY_RUN=1 forwards OpenClaw dry-run without live send', (t) => {
  const root = mkRoot(t, 'df-alert-env-');
  const run = runAlert(root, ['actual-sync.service'], { ALERT_DRY_RUN: '1' });
  assertDryRunOnly(t, run);
});

test('finance-sync-alert.sh --dry-run alone defaults unit and dry-runs', (t) => {
  const root = mkRoot(t, 'df-alert-dry-run-default-');
  const run = runAlert(root, ['--dry-run']);
  assertDryRunOnly(t, run);
  assert.match(run.dryRunMessage, /actual-sync\.service failed/);
  assert.match(run.dryRunMessage, /Bank transactions may be stale/);
});

test('finance-sync-alert.sh duplicate --dry-run still dry-runs once', (t) => {
  const root = mkRoot(t, 'df-alert-dup-dry-run-');
  const run = runAlert(root, ['--dry-run', '--dry-run', 'actual-sync.service']);
  assertDryRunOnly(t, run);
  assert.equal(run.messageArgs.filter((arg) => arg === '--dry-run').length, 1);
});

test('finance-sync-alert.sh live send remains available without dry-run flags', (t) => {
  const root = mkRoot(t, 'df-alert-live-');
  const run = runAlert(root, ['actual-sync.service']);
  assertLiveSendOnly(t, run);
  assert.match(run.message, /actual-sync\.service failed/);
  assert.match(run.message, /Bank transactions may be stale/);
});

test('finance-sync-alert.sh rejects unknown options before target discovery', (t) => {
  const root = mkRoot(t, 'df-alert-unknown-opt-');
  const run = runAlert(root, ['--verbose', 'actual-sync.service']);
  assertNoOpenclaw(t, run);
  assert.match(run.result.stderr, /unknown option/);
});

test('finance-sync-alert.sh rejects bare -- before target discovery', (t) => {
  const root = mkRoot(t, 'df-alert-bare-end-');
  const run = runAlert(root, ['--']);
  assertNoOpenclaw(t, run);
  assert.match(run.result.stderr, /unsupported option: --/);
});

test('finance-sync-alert.sh rejects -- end-of-options marker before target discovery', (t) => {
  const root = mkRoot(t, 'df-alert-end-marker-');
  const run = runAlert(root, ['--', '--dry-run']);
  assertNoOpenclaw(t, run);
  assert.match(run.result.stderr, /unsupported option: --/);
});

test('finance-sync-alert.sh rejects -- --verbose before target discovery', (t) => {
  const root = mkRoot(t, 'df-alert-end-verbose-');
  const run = runAlert(root, ['--', '--verbose']);
  assertNoOpenclaw(t, run);
  assert.match(run.result.stderr, /unsupported option: --/);
});

test('finance-sync-alert.sh rejects extra unit arguments before target discovery', (t) => {
  const root = mkRoot(t, 'df-alert-extra-unit-');
  const run = runAlert(root, ['actual-sync.service', 'finance-event-sync.service']);
  assertNoOpenclaw(t, run);
  assert.match(run.result.stderr, /too many arguments/);
});

test('finance-sync-alert.sh regression: audit probes no longer treat --dry-run as unit name', (t) => {
  // Production audit once ran `finance-sync-alert.sh --dry-run <unit>` for both sync units.
  // The legacy script treated `--dry-run` as the unit name and sent live Telegram alerts.
  const root = mkRoot(t, 'df-alert-audit-regression-');
  const probes = [
    ['--dry-run', 'actual-sync.service'],
    ['--dry-run', 'finance-event-sync.service'],
  ];

  for (const args of probes) {
    const run = runAlert(root, args);
    assertDryRunOnly(t, run);
    assert.doesNotMatch(run.dryRunMessage, /--dry-run failed/);
    assert.match(run.dryRunMessage, new RegExp(`${args[1]} failed`));
  }
});

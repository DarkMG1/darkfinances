'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const {
  loadLogrotateContract,
  readLogrotateConfig,
  validateLogrotateConfigAgainstContract,
  validateOwnershipDirectives,
} = require('../lib/logrotate-contract');

const repoRoot = path.resolve(__dirname, '..', '..');
const systemdDir = path.join(repoRoot, 'ops/systemd');

function logrotateAvailable() {
  return spawnSync('logrotate', ['--version'], { encoding: 'utf8' }).status === 0;
}

function currentIdentity() {
  const user = spawnSync('id', ['-un'], { encoding: 'utf8' });
  const group = spawnSync('id', ['-gn'], { encoding: 'utf8' });
  if (user.status !== 0 || group.status !== 0) return null;
  return {
    user: user.stdout.trim(),
    group: group.stdout.trim(),
  };
}

function uniqueLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

test('logrotate contract JSON preserves trailing newline formatting', () => {
  const raw = fs.readFileSync(path.join(repoRoot, 'ops/lib/logrotate-contract.json'), 'utf8');
  assert.match(raw, /\n$/);
  assert.doesNotThrow(() => loadLogrotateContract());
});

test('logrotate config matches contract and forbids copytruncate', () => {
  const { contract, directives, ownership } = validateLogrotateConfigAgainstContract();
  assert.equal(contract.authoritativeLogging, 'journald');
  assert.equal(contract.rotation.strategy, 'rename-create');
  assert.equal(directives.includes('copytruncate'), false);
  assert.equal(directives.includes('create'), true);
  assert.equal(directives.includes('su'), true);
  assert.equal(ownership.su.user, contract.rotation.runAsUser);
  assert.equal(ownership.su.group, contract.rotation.runAsGroup);
  assert.equal(ownership.create.mode, contract.rotation.createMode);
  assert.equal(ownership.create.user, contract.rotation.runAsUser);
  assert.equal(ownership.create.group, contract.rotation.runAsGroup);
});

test('logrotate contract rejects duplicate or conflicting su/create directives', () => {
  const contract = loadLogrotateContract();
  const base = readLogrotateConfig();
  assert.throws(
    () => validateOwnershipDirectives(`${base}\n    su other other`, contract),
    /exactly one su directive/,
  );
  assert.throws(
    () => validateOwnershipDirectives(`${base}\n    create 0600 other other`, contract),
    /exactly one create directive/,
  );
  assert.throws(
    () => validateOwnershipDirectives(
      base.replace('create 0600 dark dark', 'create 0644 dark dark'),
      contract,
    ),
    /create mode mismatch/,
  );
  assert.throws(
    () => validateOwnershipDirectives(
      base.replace('create 0600 dark dark', 'create 0600 other dark'),
      contract,
    ),
    /create ownership mismatch/,
  );
  assert.throws(
    () => validateOwnershipDirectives(
      base.replace('su dark dark', 'su other dark'),
      contract,
    ),
    /su mismatch/,
  );
});

test('logrotate contract documents journald as authoritative for reviewed systemd units', () => {
  const contract = loadLogrotateContract();
  const serviceUnits = fs
    .readdirSync(systemdDir)
    .filter((name) => name.endsWith('.service'))
    .sort();

  assert.deepEqual([...contract.reviewedJournalUnits].sort(), serviceUnits.sort());
  for (const unit of contract.reviewedJournalUnits) {
    assert.equal(fs.existsSync(path.join(systemdDir, unit)), true, `${unit} must exist`);
  }
});

test('logrotate contract paths declare short-lived legacy appenders only', () => {
  const contract = loadLogrotateContract();
  for (const entry of contract.paths) {
    assert.equal(entry.status, 'legacy-residual');
    assert.equal(entry.writerKind, 'short-lived-appender');
    assert.equal(entry.longRunningFileDescriptor, false);
    assert.equal(entry.reviewedLogging, 'journald');
    assert.match(entry.openSemantics, /journal/i);
  }
});

test('ops README documents journald-first logging and safe legacy rotation reload', () => {
  const readme = fs.readFileSync(path.join(repoRoot, 'ops/README.md'), 'utf8');
  assert.match(readme, /journald/i);
  assert.match(readme, /copytruncate/i);
  assert.match(readme, /logrotate-contract\.json/);
  assert.match(readme, /journalctl --user/);
});

test('logrotate config passes debug syntax when logrotate is installed', (t) => {
  if (!logrotateAvailable()) {
    t.skip('logrotate not installed');
    return;
  }

  const configPath = path.join(repoRoot, 'ops/logrotate-darkfinances.conf');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-logrotate-state-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const identity = currentIdentity();
  if (!identity) {
    t.skip('unable to resolve current user/group');
    return;
  }
  const logPath = path.join(stateDir, 'syntax.log');
  const fixtureConfig = path.join(stateDir, 'logrotate.conf');
  fs.writeFileSync(logPath, '', { mode: 0o600 });
  fs.writeFileSync(
    fixtureConfig,
    fs.readFileSync(configPath, 'utf8')
      .replace('/home/dark/actual/bank-sync.log /home/dark/actual-tools/*.log', logPath)
      .replace('su dark dark', `su ${identity.user} ${identity.group}`)
      .replace('create 0600 dark dark', `create 0600 ${identity.user} ${identity.group}`),
  );

  const result = spawnSync('logrotate', [
    '-d',
    '-s',
    path.join(stateDir, 'status'),
    fixtureConfig,
  ], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
});

test('rename/create rotation preserves unique lines from concurrent short-lived appenders', (t) => {
  if (!logrotateAvailable()) {
    t.skip('logrotate not installed');
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-logrotate-harness-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const identity = currentIdentity();
  if (!identity) {
    t.skip('unable to resolve current user/group');
    return;
  }

  const logDir = path.join(tempRoot, 'logs');
  const logPath = path.join(logDir, 'bank-sync.log');
  const configPath = path.join(tempRoot, 'logrotate.conf');
  const statePath = path.join(tempRoot, 'status');
  fs.mkdirSync(logDir, { mode: 0o700 });

  const config = readLogrotateConfig()
    .replace('/home/dark/actual/bank-sync.log /home/dark/actual-tools/*.log', logPath)
    .replace('su dark dark', `su ${identity.user} ${identity.group}`)
    .replace('create 0600 dark dark', `create 0600 ${identity.user} ${identity.group}`);
  fs.writeFileSync(configPath, config);

  const emitted = new Set();
  const appendLine = (id) => {
    fs.appendFileSync(logPath, `${id}\n`, { mode: 0o600 });
    emitted.add(id);
  };

  for (let index = 0; index < 20; index += 1) {
    appendLine(`pre-${index}`);
  }

  const rotate = () => {
    const result = spawnSync('logrotate', ['-f', '-s', statePath, configPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  };

  rotate();

  for (let index = 0; index < 40; index += 1) {
    appendLine(`post-${index}`);
    if (index === 10 || index === 25) rotate();
  }

  const collected = new Set();
  for (const name of fs.readdirSync(logDir).filter((entry) => entry.startsWith('bank-sync.log'))) {
    const filePath = path.join(logDir, name);
    const contents = name.endsWith('.gz')
      ? zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf8')
      : fs.readFileSync(filePath, 'utf8');
    for (const line of uniqueLines(contents)) {
      collected.add(line);
    }
  }

  for (const id of emitted) {
    assert.equal(collected.has(id), true, `missing rotated line ${id}`);
  }
  assert.equal(collected.size, emitted.size);
});

test('rename/create rotation preserves lines written on a held descriptor after rotate', (t) => {
  if (!logrotateAvailable()) {
    t.skip('logrotate not installed');
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-logrotate-held-fd-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const identity = currentIdentity();
  if (!identity) {
    t.skip('unable to resolve current user/group');
    return;
  }

  const logPath = path.join(tempRoot, 'held.log');
  const configPath = path.join(tempRoot, 'logrotate.conf');
  const statePath = path.join(tempRoot, 'status');

  fs.writeFileSync(logPath, 'before-rotate\n', { mode: 0o600 });
  fs.writeFileSync(configPath, [
    `${logPath} {`,
    '    rotate 3',
    `    create 0600 ${identity.user} ${identity.group}`,
    '}',
  ].join('\n'));

  const fd = fs.openSync(logPath, 'a');
  try {
    fs.writeSync(fd, 'held-before\n');
    const rotate = spawnSync('logrotate', ['-f', '-s', statePath, configPath], { encoding: 'utf8' });
    assert.equal(rotate.status, 0, `${rotate.stderr}\n${rotate.stdout}`);
    fs.writeSync(fd, 'held-after\n');
  } finally {
    fs.closeSync(fd);
  }

  fs.appendFileSync(logPath, 'fresh-open\n', { mode: 0o600 });

  const rotated = fs.existsSync(`${logPath}.1`)
    ? uniqueLines(fs.readFileSync(`${logPath}.1`, 'utf8'))
    : [];
  const active = uniqueLines(fs.readFileSync(logPath, 'utf8'));

  assert.deepEqual(rotated, ['before-rotate', 'held-before', 'held-after']);
  assert.deepEqual(active, ['fresh-open']);
});

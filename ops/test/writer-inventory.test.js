'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadWriterInventory } = require('../lib/writer-inventory');
const {
  isWriterQuiescent,
  captureWriterState,
  waitForWriterQuiescence,
  verifyAllQuiescent,
  stopWriter,
} = require('../lib/writer-quiescence');
const { createMockRunners } = require('./fixtures/coordinated-backup-fixtures');

const inventoryPath = path.join(__dirname, '..', 'lib', 'writer-inventory.json');

test('writer inventory JSON preserves trailing newline formatting', () => {
  const raw = fs.readFileSync(inventoryPath, 'utf8');
  assert.match(raw, /\n$/);
  assert.doesNotThrow(() => loadWriterInventory());
});

test('actual-container quiescentStates includes Docker exited status', () => {
  const inventory = loadWriterInventory();
  const writer = inventory.writers.find((entry) => entry.id === 'actual-container');
  assert.ok(writer);
  assert.ok(writer.quiescentStates.includes('exited'));
  assert.ok(writer.quiescentStates.includes('stopped'));
});

test('exited actual-container passes isWriterQuiescent and wait polling without stop', async () => {
  const inventory = loadWriterInventory();
  const writer = inventory.writers.find((entry) => entry.id === 'actual-container');
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'df-exited-quiescent-'));
  try {
    const runners = createMockRunners({ containers: { actual: 'exited' } });
    const context = {
      inventory,
      env: { BACKUP_INCLUDE_ACTUAL_DATA: '1', HOME: root },
      runners,
      pollMs: 1,
      stopDeadlineMs: 50,
    };
    const snapshot = captureWriterState(writer, context);
    assert.equal(snapshot.state, 'exited');
    assert.equal(snapshot.originallyRunning, false);
    assert.ok(isWriterQuiescent(writer, snapshot));
    assert.equal(await waitForWriterQuiescence(writer, snapshot, context, 50), true);
    const map = new Map([[writer.id, snapshot]]);
    context.writers = [writer];
    const verify = await verifyAllQuiescent(context, map);
    assert.equal(verify.ok, true);
    const stop = await stopWriter(writer, snapshot, context);
    assert.equal(stop.skipped, true);
    assert.equal(runners.commands.some((entry) => entry.includes('compose') && entry.includes('stop')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('waitForWriterQuiescence accepts exited after docker compose stop', async () => {
  const inventory = loadWriterInventory();
  const writer = inventory.writers.find((entry) => entry.id === 'actual-container');
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'df-exited-after-stop-'));
  const compose = path.join(root, 'compose.yml');
  fs.writeFileSync(compose, 'services:\n  actual:\n    image: test\n');
  try {
    const runners = createMockRunners({
      containers: { actual: 'running' },
      restartPolicies: { actual: 'unless-stopped' },
    });
    const originalStop = runners.dockerComposeStop.bind(runners);
    runners.dockerComposeStop = (composeFile, serviceName) => {
      const result = originalStop(composeFile, serviceName);
      runners.containers.set(serviceName, 'exited');
      return result;
    };
    const context = {
      inventory,
      env: {
        BACKUP_INCLUDE_ACTUAL_DATA: '1',
        HOME: root,
        ACTUAL_COMPOSE_FILE: compose,
      },
      runners,
      pollMs: 1,
      stopDeadlineMs: 200,
    };
    const snapshot = captureWriterState(writer, context);
    snapshot.originallyRunning = true;
    snapshot.originallyActive = true;
    const stop = await stopWriter(writer, snapshot, context);
    assert.equal(stop.ok, true);
    assert.equal(snapshot.state, 'exited');
    assert.ok(isWriterQuiescent(writer, snapshot));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

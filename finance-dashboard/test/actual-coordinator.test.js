'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const NodeCache = require('node-cache');
const {
  ActualCoordinator,
  resetActualCoordinator,
  MAX_NEST_DEPTH,
} = require('../lib/actual-coordinator');

test('runWrite blocks runRead until the write completes', async () => {
  const coordinator = resetActualCoordinator('test-write-blocks-read');
  const events = [];
  const write = coordinator.runWrite(async () => {
    events.push('write:start');
    await new Promise((resolve) => setTimeout(resolve, 25));
    events.push('write:end');
    return 'written';
  }, { label: 'write' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const read = coordinator.runRead(async () => {
    events.push('read');
    return 'read';
  }, { label: 'read' });
  assert.deepEqual(await Promise.all([write, read]), ['written', 'read']);
  assert.deepEqual(events, ['write:start', 'write:end', 'read']);
});

test('runRead then runWrite preserves ordering', async () => {
  const coordinator = resetActualCoordinator('test-read-then-write');
  const events = [];
  const read = coordinator.runRead(async () => {
    events.push('read:start');
    await new Promise((resolve) => setTimeout(resolve, 15));
    events.push('read:end');
    return 1;
  }, { label: 'read' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const write = coordinator.runWrite(async () => {
    events.push('write');
    return 2;
  }, { label: 'write' });
  assert.deepEqual(await Promise.all([read, write]), [1, 2]);
  assert.deepEqual(events, ['read:start', 'read:end', 'write']);
});

test('delete then re-add advances generation before cached read republishes', async () => {
  const coordinator = resetActualCoordinator('test-delete-readd');
  const cache = new NodeCache();
  coordinator.bindCache(cache);
  let value = 'before';
  await coordinator.cachedRead('txn', async () => ({ value }), 30);
  await coordinator.runWrite(async () => {
    value = 'after';
  }, { label: 'delete-readd' });
  const fresh = await coordinator.cachedRead('txn', async () => ({ value }), 30);
  assert.equal(fresh.value, 'after');
});

test('saga recovery barrier excludes concurrent reads', async () => {
  const coordinator = resetActualCoordinator('test-recover-barrier');
  const events = [];
  const recover = coordinator.runRecover(async () => {
    events.push('recover:start');
    await new Promise((resolve) => setTimeout(resolve, 25));
    events.push('recover:end');
  }, { label: 'recover' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const read = coordinator.runRead(async () => {
    events.push('read');
  }, { label: 'read' });
  await Promise.all([recover, read]);
  assert.deepEqual(events, ['recover:start', 'recover:end', 'read']);
});

test('stale-generation cache fill is discarded after invalidation', async () => {
  const coordinator = resetActualCoordinator('test-stale-fill-simple');
  const cache = new NodeCache();
  coordinator.bindCache(cache);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = coordinator.runRead(async ({ generation }) => {
    await gate;
    coordinator.publishCacheEntry('key', { ok: true }, 30, generation);
    return { ok: true };
  }, { label: 'slow' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  coordinator.invalidateGeneration();
  release();
  await slow;
  assert.equal(coordinator.readCacheEntry('key'), undefined);
  assert.equal(coordinator.getHealth().stats.staleFillsDiscarded, 1);
});

test('failed read does not poison later queue work', async () => {
  const coordinator = resetActualCoordinator('test-failed-read');
  await assert.rejects(
    coordinator.runRead(async () => { throw new Error('read failed'); }, { label: 'fail' }),
    /read failed/,
  );
  assert.equal(await coordinator.runRead(async () => 'ok', { label: 'recover' }), 'ok');
  assert.equal(coordinator.getHealth().stats.readsStarted, 2);
});

test('nested coordinator calls bypass re-entry without deadlock', async () => {
  const coordinator = resetActualCoordinator('test-nested');
  const result = await coordinator.runRead(async () => coordinator.runRead(async () => 'nested', { label: 'inner' }), { label: 'outer' });
  assert.equal(result, 'nested');
  assert.ok(coordinator.getHealth().stats.nestedBypasses >= 1);
});

test('close rejects new coordinator work while drain waits for accepted work', async () => {
  const coordinator = resetActualCoordinator('test-close');
  let finished = false;
  coordinator.runRead(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    finished = true;
    return true;
  }, { label: 'in-flight' });
  coordinator.close();
  await assert.rejects(coordinator.runRead(async () => true, { label: 'rejected' }), /closed/);
  await coordinator.drain(100);
  assert.equal(finished, true);
});

test('generation-scoped cachedRead publishes only current data', async () => {
  const coordinator = resetActualCoordinator('test-cached-read');
  const cache = new NodeCache();
  coordinator.bindCache(cache);
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return { n: calls };
  };
  const first = await coordinator.cachedRead('key', loader, 30);
  const second = await coordinator.cachedRead('key', loader, 30);
  assert.deepEqual(first, { n: 1 });
  assert.deepEqual(second, { n: 1 });
  coordinator.invalidateGeneration();
  const third = await coordinator.cachedRead('key', loader, 30);
  assert.deepEqual(third, { n: 2 });
});

test('targeted invalidateGeneration bumps generation and retires non-listed entries', async () => {
  const coordinator = resetActualCoordinator('test-targeted-invalidate');
  const cache = new NodeCache();
  coordinator.bindCache(cache);
  await coordinator.cachedRead('accounts', async () => ({ name: 'a' }), 30);
  await coordinator.cachedRead('events', async () => ({ events: [] }), 30);
  coordinator.invalidateGeneration({ keys: ['accounts'] });
  assert.equal(coordinator.readCacheEntry('accounts'), undefined);
  assert.equal(coordinator.readCacheEntry('events'), undefined);
  assert.equal(coordinator.getHealth().generation, 1);
});

test('nested depth cap surfaces accidental cycles', async () => {
  const coordinator = resetActualCoordinator('test-depth-cap');
  await assert.rejects(
    coordinator.runRead(async function loop() {
      return coordinator.runRead(loop, { label: 'loop' });
    }, { label: 'outer' }),
    new RegExp(`depth exceeded \\(${MAX_NEST_DEPTH}\\)`),
  );
});

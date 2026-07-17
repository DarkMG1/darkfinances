'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const NodeCache = require('node-cache');
const { ActualCoordinator } = require('../lib/actual-coordinator');

function legacyCached(cache, key, fn, ttl = 300) {
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  return fn().then((value) => {
    cache.set(key, value, ttl);
    return value;
  });
}

function legacyWarmParallel(cache, targets) {
  return Promise.allSettled(
    targets.map(async ({ key, ttl, fn }) => {
      cache.set(key, await fn(), ttl);
    }),
  );
}

test('reproduction: uncoordinated GET overlaps queued mutation on fake Actual', async () => {
  let actualLane = 'idle';
  let generation = 0;
  const mutationQueue = [];
  let tail = Promise.resolve();

  const runMutation = (task) => {
    tail = tail.then(async () => {
      actualLane = 'write';
      generation += 1;
      await task();
      actualLane = 'idle';
    });
    return tail;
  };

  const runGet = (task) => {
    if (actualLane === 'write') {
      return task();
    }
    actualLane = 'read';
    return task().finally(() => { actualLane = 'idle'; });
  };

  let observedDuringWrite = null;
  const getPromise = runGet(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    observedDuringWrite = actualLane;
    return generation;
  });

  const writePromise = runMutation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  await Promise.all([getPromise, writePromise]);
  assert.equal(observedDuringWrite, 'write');
});

test('reproduction: stale cache fill can publish after legacy flush', async () => {
  const cache = new NodeCache();
  let generation = 0;
  let releaseRead;
  const gate = new Promise((resolve) => { releaseRead = resolve; });

  const fill = legacyCached(cache, 'accounts', async () => {
    const captured = generation;
    await gate;
    if (captured === generation) cache.set('accounts', { captured, value: 'stale' }, 30);
    return { captured, value: 'stale' };
  });

  generation += 1;
  cache.flushAll();
  releaseRead();
  await fill;
  const hit = cache.get('accounts');
  assert.ok(hit);
  assert.equal(hit.value, 'stale');
});

test('reproduction: coordinator generation fill rejects stale publication', async () => {
  const coordinator = new ActualCoordinator('race-fix');
  const cache = new NodeCache();
  coordinator.bindCache(cache);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fill = coordinator.runRead(async ({ generation }) => {
    await gate;
    coordinator.publishCacheEntry('accounts', { captured: generation, value: 'stale' }, 30, generation);
    return { captured: generation, value: 'stale' };
  }, { label: 'slow-fill' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  coordinator.invalidateGeneration();
  release();
  await fill;
  assert.equal(coordinator.readCacheEntry('accounts'), undefined);
  assert.equal(coordinator.getHealth().stats.staleFillsDiscarded, 1);
});

test('reproduction: parallel warmCache without coordinator can interleave writes', async () => {
  const cache = new NodeCache();
  let lane = 0;
  const targets = [
    { key: 'a', ttl: 30, fn: async () => { lane += 1; await new Promise((r) => setTimeout(r, 15)); return 'a'; } },
    { key: 'b', ttl: 30, fn: async () => { lane += 1; await new Promise((r) => setTimeout(r, 5)); return 'b'; } },
  ];
  await legacyWarmParallel(cache, targets);
  assert.equal(lane, 2);
  assert.equal(cache.get('a'), 'a');
  assert.equal(cache.get('b'), 'b');
});

test('reproduction: serial warmCache through coordinator preserves lane exclusivity', async () => {
  const coordinator = new ActualCoordinator('warm-serial');
  const cache = new NodeCache();
  coordinator.bindCache(cache);
  let maxLane = 0;
  let lane = 0;
  const targets = [
    { key: 'a', ttl: 30, fn: async () => { lane += 1; maxLane = Math.max(maxLane, lane); await new Promise((r) => setTimeout(r, 10)); lane -= 1; return 'a'; } },
    { key: 'b', ttl: 30, fn: async () => { lane += 1; maxLane = Math.max(maxLane, lane); await new Promise((r) => setTimeout(r, 10)); lane -= 1; return 'b'; } },
  ];
  for (const { key, ttl, fn } of targets) {
    await coordinator.cachedRead(key, fn, ttl);
  }
  assert.equal(maxLane, 1);
});

test('cachedRead admits generation at cache miss and retries after invalidation during fill', async () => {
  const coordinator = new ActualCoordinator('admit-retry');
  const cache = new NodeCache();
  coordinator.bindCache(cache);
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fill = coordinator.cachedRead('events', async () => {
    calls += 1;
    await gate;
    return { events: [{ name: calls === 1 ? 'StaleEvent' : 'FreshEvent' }] };
  }, 30);
  await new Promise((resolve) => setTimeout(resolve, 5));
  coordinator.invalidateGeneration({ keys: ['events'] });
  release();
  const result = await fill;
  assert.equal(result.events[0].name, 'FreshEvent');
  assert.equal(coordinator.readCacheEntry('events').events[0].name, 'FreshEvent');
  assert.equal(calls, 2);
  assert.equal(coordinator.getHealth().stats.staleFillsDiscarded, 1);
  assert.equal(coordinator.getHealth().stats.staleFillRetries, 1);
});

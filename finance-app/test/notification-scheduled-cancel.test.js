const test = require('node:test');
const assert = require('node:assert/strict');
const { confirmCancelScheduledIds } = require('../src/lib/notification-scheduled-cancel');

function createCancelDeps(overrides = {}) {
  const scheduled = new Map(overrides.initial ?? []);
  const cancelled = [];
  const rejectIds = new Set(overrides.rejectIds ?? []);
  const applyThenThrowIds = new Set(overrides.applyThenThrowIds ?? []);
  let enumFails = overrides.enumFails ?? false;
  let omitEnumeration = overrides.omitEnumeration ?? false;

  return {
    scheduled,
    cancelled,
    deps: {
      cancelScheduledNotificationAsync: async (id) => {
        if (rejectIds.has(id)) {
          throw new Error(`cancel rejected: ${id}`);
        }
        if (applyThenThrowIds.has(id)) {
          cancelled.push(id);
          scheduled.delete(id);
          throw new Error(`cancel threw after apply: ${id}`);
        }
        cancelled.push(id);
        scheduled.delete(id);
      },
      getAllScheduledNotificationsAsync: omitEnumeration
        ? undefined
        : async () => {
          if (enumFails) throw new Error('enumeration failed');
          return [...scheduled.keys()].map((id) => ({ identifier: id }));
        },
    },
  };
}

test('confirmCancelScheduledIds marks definite rejections as retained when still present', async () => {
  const harness = createCancelDeps({
    initial: [['live-1', {}]],
    rejectIds: ['live-1'],
  });

  const result = await confirmCancelScheduledIds(harness.deps, ['live-1']);
  assert.deepEqual(result.confirmed, []);
  assert.deepEqual(result.retained, ['live-1']);
  assert.equal(result.results[0].confirmation, 'still_present');
  assert.ok(harness.scheduled.has('live-1'));
});

test('confirmCancelScheduledIds treats apply-then-throw as confirmed when absent from OS', async () => {
  const harness = createCancelDeps({
    initial: [['gone-1', {}]],
    applyThenThrowIds: ['gone-1'],
  });

  const result = await confirmCancelScheduledIds(harness.deps, ['gone-1']);
  assert.deepEqual(result.confirmed, ['gone-1']);
  assert.deepEqual(result.retained, []);
  assert.equal(result.results[0].confirmation, 'confirmed');
  assert.equal(harness.scheduled.has('gone-1'), false);
});

test('confirmCancelScheduledIds retains IDs when enumeration fails', async () => {
  const harness = createCancelDeps({
    initial: [['live-1', {}]],
    enumFails: true,
  });

  const result = await confirmCancelScheduledIds(harness.deps, ['live-1']);
  assert.deepEqual(result.confirmed, []);
  assert.deepEqual(result.retained, ['live-1']);
  assert.equal(result.results[0].confirmation, 'unknown');
});

test('confirmCancelScheduledIds retains IDs when enumeration is unavailable', async () => {
  const harness = createCancelDeps({
    initial: [['live-1', {}]],
    omitEnumeration: true,
  });

  const result = await confirmCancelScheduledIds(harness.deps, ['live-1']);
  assert.deepEqual(result.confirmed, []);
  assert.deepEqual(result.retained, ['live-1']);
  assert.equal(result.results[0].confirmation, 'unknown');
});

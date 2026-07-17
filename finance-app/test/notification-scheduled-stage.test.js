const test = require('node:test');
const assert = require('node:assert/strict');
const {
  allTrackedIds,
  normalizeCategoryState,
  osLiveIds,
  readCategoryState,
  writeCategoryState,
} = require('../src/lib/notification-scheduled-stage');

test('normalizeCategoryState accepts legacy committed arrays', () => {
  assert.deepEqual(normalizeCategoryState(['a', 'b']), {
    canonical: ['a', 'b'],
    pending: [],
    retiring: [],
    cleanup: [],
    laneToken: null,
    purgeTombstone: false,
  });
});

test('osLiveIds includes canonical pending retiring and cleanup IDs', () => {
  const live = osLiveIds({
    canonical: ['new-1'],
    pending: [],
    retiring: ['old-1'],
    cleanup: ['purge-1'],
    laneToken: null,
  });
  assert.deepEqual(live.sort(), ['new-1', 'old-1', 'purge-1']);
});

test('writeCategoryState collapses clean committed sets to arrays', () => {
  const tracked = {};
  writeCategoryState(tracked, 'weekly', {
    canonical: ['live-1'],
    pending: [],
    retiring: [],
    cleanup: [],
    laneToken: null,
    purgeTombstone: false,
  });
  assert.deepEqual(tracked.weekly, ['live-1']);
  assert.deepEqual(allTrackedIds(readCategoryState(tracked, 'weekly')), ['live-1']);
});

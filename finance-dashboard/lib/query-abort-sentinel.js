'use strict';

const fs = require('fs');
const path = require('path');

const sentinel = {
  abortCount: 0,
  lastPhase: null,
  listenersAttached: 0,
  listenersDisposed: 0,
};

function enabled() {
  return process.env.NODE_ENV === 'test';
}

function recordQueryAbort(phase) {
  if (!enabled()) return;
  sentinel.abortCount += 1;
  sentinel.lastPhase = phase || null;
  if (phase === 'graceful shutdown') {
    const dir = process.env.FINANCE_QUERY_TEST_BARRIER_DIR;
    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'abort-recorded'), JSON.stringify({
          phase,
          abortCount: sentinel.abortCount,
          at: Date.now(),
        }));
      } catch (_) { /* test-only marker */ }
    }
  }
}

function recordClientAbortListenersAttached(count = 1) {
  if (!enabled()) return;
  sentinel.listenersAttached += count;
}

function recordClientAbortListenersDisposed(count = 1) {
  if (!enabled()) return;
  sentinel.listenersDisposed += count;
}

function getQueryAbortSentinelSnapshot() {
  return { ...sentinel };
}

function resetQueryAbortSentinel() {
  sentinel.abortCount = 0;
  sentinel.lastPhase = null;
  sentinel.listenersAttached = 0;
  sentinel.listenersDisposed = 0;
}

module.exports = {
  getQueryAbortSentinelSnapshot,
  recordClientAbortListenersAttached,
  recordClientAbortListenersDisposed,
  recordQueryAbort,
  resetQueryAbortSentinel,
};

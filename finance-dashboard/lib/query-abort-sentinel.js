'use strict';

const sentinel = {
  abortCount: 0,
  lastPhase: null,
  listenersAttached: 0,
  listenersDisposed: 0,
};

function enabled() {
  return process.env.NODE_ENV === 'test';
}

function writeGracefulShutdownTestMarker(payload) {
  const dir = process.env.FINANCE_QUERY_TEST_BARRIER_DIR;
  if (!dir || !enabled()) return;
  try {
    const { writeAtomicJsonMarker } = require('../test/helpers/atomic-markers');
    writeAtomicJsonMarker(dir, 'abort-recorded', payload);
  } catch (_) { /* test-only marker */ }
}

function recordQueryAbort(phase) {
  if (!enabled()) return;
  sentinel.abortCount += 1;
  sentinel.lastPhase = phase || null;
  if (phase === 'graceful shutdown') {
    writeGracefulShutdownTestMarker({
      phase,
      abortCount: sentinel.abortCount,
      at: Date.now(),
    });
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

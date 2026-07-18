'use strict';

const { createReconnectRefreshOwner } = require('./reconnect-refresh');

/**
 * Test harness mirroring ReconnectRefreshOwner React wiring without React.
 */
function createReconnectRefreshOwnerRunner(deps) {
  const scheduled = [];
  const owner = createReconnectRefreshOwner({
    ...deps,
    schedule: (fn, delayMs) => {
      const handle = { fn, delayMs, cancelled: false };
      scheduled.push(handle);
      return handle;
    },
    cancelSchedule: (handle) => {
      handle.cancelled = true;
    },
  });

  function flushSchedules(maxDelay = Infinity) {
    while (scheduled.some((item) => !item.cancelled && item.delayMs <= maxDelay)) {
      const nextIndex = scheduled.findIndex((item) => !item.cancelled && item.delayMs <= maxDelay);
      if (nextIndex < 0) break;
      const [item] = scheduled.splice(nextIndex, 1);
      if (!item.cancelled) item.fn();
    }
  }

  function pendingDelayMs() {
    const pending = scheduled.filter((item) => !item.cancelled);
    if (!pending.length) return null;
    return Math.min(...pending.map((item) => item.delayMs));
  }

  return {
    owner,
    flushSchedules,
    pendingDelayMs,
    scheduledCount: () => scheduled.filter((item) => !item.cancelled).length,
  };
}

module.exports = {
  createReconnectRefreshOwnerRunner,
};

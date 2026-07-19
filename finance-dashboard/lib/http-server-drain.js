'use strict';

class HttpDrainTimeoutError extends Error {
  constructor(message, { reason = 'timeout' } = {}) {
    super(message);
    this.name = 'HttpDrainTimeoutError';
    this.reason = reason;
  }
}

const IDLE_KEEP_ALIVE_SWEEP_MS = 50;

const inFlightClosePromises = new WeakMap();

function canDrainImmediately(server) {
  return !server || typeof server.close !== 'function' || !server.listening;
}

function getRedactedHttpDiagnostics(server) {
  return {
    listening: Boolean(server?.listening),
    canForceClose: typeof server?.closeAllConnections === 'function',
    canCloseIdle: typeof server?.closeIdleConnections === 'function',
  };
}

function closeIdleKeepAlive(server) {
  if (server && typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }
}

function forceCloseHttpConnections(server) {
  if (!server) return;
  closeIdleKeepAlive(server);
  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
}

function isWeakMapServer(server) {
  return server != null && typeof server === 'object';
}

function closeHttpServer(server) {
  if (!server || typeof server.close !== 'function') {
    return Promise.resolve({ wasListening: false, alreadyClosed: true });
  }

  if (isWeakMapServer(server) && inFlightClosePromises.has(server)) {
    return inFlightClosePromises.get(server);
  }

  if (!server.listening) {
    return Promise.resolve({ wasListening: false, alreadyClosed: true });
  }

  const promise = new Promise((resolve, reject) => {
    let settled = false;
    let idleSweepTimer = null;

    const cleanup = () => {
      if (idleSweepTimer != null) {
        clearInterval(idleSweepTimer);
        idleSweepTimer = null;
      }
      if (isWeakMapServer(server)) {
        inFlightClosePromises.delete(server);
      }
    };

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };

    const sweepIdleKeepAlive = () => {
      if (settled) return;
      closeIdleKeepAlive(server);
    };

    try {
      server.close((error) => {
        finish(error, { wasListening: true, drained: true });
      });
    } catch (error) {
      finish(error);
      return;
    }

    sweepIdleKeepAlive();
    if (!settled && typeof server.closeIdleConnections === 'function') {
      idleSweepTimer = setInterval(sweepIdleKeepAlive, IDLE_KEEP_ALIVE_SWEEP_MS);
      idleSweepTimer.unref?.();
    }
  });

  if (isWeakMapServer(server)) {
    inFlightClosePromises.set(server, promise);
  }
  return promise;
}

function rejectHttpDrainTimeout(server, error, onDiagnostic) {
  if (typeof onDiagnostic === 'function') {
    onDiagnostic({
      phase: 'http-drain-timeout',
      reason: error.reason,
      message: String(error.message),
      ...getRedactedHttpDiagnostics(server),
    });
  }
  forceCloseHttpConnections(server);
  throw error;
}

async function closeHttpServerWithTimeout(server, timeoutMs, { onDiagnostic } = {}) {
  if (!Number.isFinite(timeoutMs)) {
    rejectHttpDrainTimeout(
      server,
      new HttpDrainTimeoutError(`HTTP server drain timeout is invalid (${timeoutMs})`, {
        reason: 'invalid-timeout',
      }),
      onDiagnostic,
    );
  }

  if (timeoutMs <= 0) {
    if (canDrainImmediately(server)) {
      return closeHttpServer(server);
    }
    rejectHttpDrainTimeout(
      server,
      new HttpDrainTimeoutError(`HTTP server drain budget exhausted (${timeoutMs}ms remaining)`, {
        reason: 'budget-exhausted',
      }),
      onDiagnostic,
    );
  }

  let timer;
  try {
    return await Promise.race([
      closeHttpServer(server),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new HttpDrainTimeoutError(`HTTP server did not drain within ${timeoutMs}ms`, {
            reason: 'timeout',
          }));
        }, timeoutMs);
      }),
    ]);
  } catch (caught) {
    const error = caught instanceof HttpDrainTimeoutError
      ? caught
      : new HttpDrainTimeoutError(String(caught?.message || caught), { reason: 'timeout' });
    rejectHttpDrainTimeout(server, error, onDiagnostic);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  HttpDrainTimeoutError,
  closeHttpServer,
  closeHttpServerWithTimeout,
  closeIdleKeepAlive,
  forceCloseHttpConnections,
  getRedactedHttpDiagnostics,
};

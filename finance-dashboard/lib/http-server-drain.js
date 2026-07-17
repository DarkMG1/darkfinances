'use strict';

class HttpDrainTimeoutError extends Error {
  constructor(message, { reason = 'timeout' } = {}) {
    super(message);
    this.name = 'HttpDrainTimeoutError';
    this.reason = reason;
  }
}

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

function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    if (!server || typeof server.close !== 'function') {
      resolve({ wasListening: false, alreadyClosed: true });
      return;
    }
    if (!server.listening) {
      resolve({ wasListening: false, alreadyClosed: true });
      return;
    }

    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };

    server.close((error) => {
      finish(error, { wasListening: true, drained: true });
    });
    closeIdleKeepAlive(server);
  });
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

'use strict';

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

async function closeHttpServerWithTimeout(server, timeoutMs, { onDiagnostic } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return closeHttpServer(server);
  }

  let timer;
  try {
    return await Promise.race([
      closeHttpServer(server),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`HTTP server did not drain within ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (typeof onDiagnostic === 'function') {
      onDiagnostic({
        phase: 'http-drain-timeout',
        message: String(error?.message || error),
        ...getRedactedHttpDiagnostics(server),
      });
    }
    forceCloseHttpConnections(server);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  closeHttpServer,
  closeHttpServerWithTimeout,
  closeIdleKeepAlive,
  forceCloseHttpConnections,
  getRedactedHttpDiagnostics,
};

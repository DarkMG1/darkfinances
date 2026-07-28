'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { closeHttpServer, closeIdleKeepAlive } = require('../lib/http-server-drain');

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    http.Server.prototype.close.call(server, (error) => (error ? reject(error) : resolve()));
  }).catch(() => {});
}

function createFakeKeepAliveDrainServer() {
  let closeCallback = null;
  let connectionPhase = 'active';

  const server = {
    listening: true,
    close(callback) {
      closeCallback = callback;
      tryFinish();
    },
    closeIdleConnections() {
      if (connectionPhase === 'idle') {
        connectionPhase = 'drained';
        tryFinish();
      }
    },
  };

  function tryFinish() {
    if (closeCallback && connectionPhase === 'drained') {
      const callback = closeCallback;
      closeCallback = null;
      callback();
    }
  }

  return {
    server,
    becomeIdle() {
      connectionPhase = 'idle';
    },
  };
}

function closeHttpServerSingleSweep(server) {
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

    try {
      server.close((error) => {
        finish(error, { wasListening: true, drained: true });
      });
    } catch (error) {
      finish(error);
      return;
    }
    closeIdleKeepAlive(server);
  });
}

function registerHttpResources(t, {
  server,
  agent,
  requests = [],
  releaseHandler = null,
} = {}) {
  t.after(async () => {
    if (releaseHandler) releaseHandler.resolve();
    for (const request of requests) {
      request.destroy();
    }
    if (agent) agent.destroy();
    await closeServer(server).catch(() => {});
  });
}

function waitForDrain(promise, timeoutMs = 150) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`drain did not settle within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer != null) clearTimeout(timer);
  });
}

test('closeHttpServer accepts null, undefined, and non-object inputs', async () => {
  for (const input of [null, undefined, 0, 'server']) {
    assert.deepEqual(
      await closeHttpServer(input),
      { wasListening: false, alreadyClosed: true },
    );
  }
});

test('closeHttpServer resolves when server is not listening', async (t) => {
  const server = http.createServer((_req, res) => res.end('ok'));
  registerHttpResources(t, { server });
  assert.deepEqual(
    await closeHttpServer(server),
    { wasListening: false, alreadyClosed: true },
  );
});

test('closeHttpServer resolves immediately when no connections remain', async (t) => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await listen(server);
  registerHttpResources(t, { server });

  assert.deepEqual(await closeHttpServer(server), { wasListening: true, drained: true });
});

test('closeHttpServer resolves on synchronous close callback', async () => {
  const server = {
    listening: true,
    close(callback) {
      callback();
    },
    closeIdleConnections() {},
  };

  assert.deepEqual(await closeHttpServer(server), { wasListening: true, drained: true });
});

test('closeHttpServer after synchronous close callback success starts a fresh drain', async () => {
  let closeCalls = 0;
  const server = {
    listening: true,
    close(callback) {
      closeCalls += 1;
      callback();
    },
    closeIdleConnections() {},
  };

  assert.deepEqual(await closeHttpServer(server), { wasListening: true, drained: true });
  assert.deepEqual(await closeHttpServer(server), { wasListening: true, drained: true });
  assert.equal(closeCalls, 2);
});

test('closeHttpServer rejects synchronous throw from server.close', async () => {
  const closeError = new Error('close threw');
  const server = {
    listening: true,
    close() {
      throw closeError;
    },
    closeIdleConnections() {},
  };

  await assert.rejects(() => closeHttpServer(server), closeError);
});

test('closeHttpServer after synchronous throw starts a fresh drain', async () => {
  const closeError = new Error('close threw');
  let closeCalls = 0;
  const server = {
    listening: true,
    close() {
      closeCalls += 1;
      throw closeError;
    },
    closeIdleConnections() {},
  };

  await assert.rejects(() => closeHttpServer(server), closeError);
  await assert.rejects(() => closeHttpServer(server), closeError);
  assert.equal(closeCalls, 2);
});

test('closeHttpServer rejects close callback error without unhandled rejections', async (t) => {
  const closeError = new Error('close failed');
  const server = http.createServer();
  await listen(server);
  registerHttpResources(t, { server });

  server.close = (callback) => {
    callback(closeError);
  };

  await assert.rejects(() => closeHttpServer(server), closeError);
});

test('closeHttpServer after close callback error starts a fresh drain', async () => {
  const closeError = new Error('close failed');
  let closeCalls = 0;
  const server = {
    listening: true,
    close(callback) {
      closeCalls += 1;
      callback(closeError);
    },
    closeIdleConnections() {},
  };

  await assert.rejects(() => closeHttpServer(server), closeError);
  await assert.rejects(() => closeHttpServer(server), closeError);
  assert.equal(closeCalls, 2);
});

test('first idle sweep throw rejects drain and releases cache', async () => {
  const sweepError = new Error('first sweep failed');
  const server = {
    listening: true,
    close() {},
    closeIdleConnections() {
      throw sweepError;
    },
  };

  await assert.rejects(() => closeHttpServer(server), sweepError);
  await assert.rejects(() => closeHttpServer(server), sweepError);
});

test('later idle sweep throw rejects drain and clears interval', async () => {
  const sweepError = new Error('interval sweep failed');
  let idleCalls = 0;
  const server = {
    listening: true,
    close() {},
    closeIdleConnections() {
      idleCalls += 1;
      if (idleCalls > 1) throw sweepError;
    },
  };

  const closePromise = closeHttpServer(server);
  await assert.rejects(() => waitForDrain(closePromise, 200), sweepError);
  assert.ok(idleCalls >= 2);

  await assert.rejects(() => closeHttpServer(server), sweepError);
});

test('repeated closeHttpServer calls share one in-flight drain', async (t) => {
  const handlerEntered = createDeferred();
  const releaseHandler = createDeferred();
  const responseEnded = createDeferred();

  const server = http.createServer((_req, res) => {
    handlerEntered.resolve();
    void releaseHandler.promise.then(() => {
      res.writeHead(200, { Connection: 'keep-alive' });
      res.end('ok');
    });
  });
  await listen(server);
  const port = server.address().port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const requests = [];

  const request = http.get(`http://127.0.0.1:${port}/`, { agent }, (res) => {
    res.resume();
    res.on('end', () => responseEnded.resolve());
  });
  request.on('error', () => {});
  requests.push(request);
  registerHttpResources(t, { server, agent, requests, releaseHandler });

  await handlerEntered.promise;
  const firstClose = closeHttpServer(server);
  const secondClose = closeHttpServer(server);
  assert.equal(firstClose, secondClose);

  releaseHandler.resolve();
  await responseEnded.promise;

  const [firstResult, secondResult] = await Promise.all([firstClose, secondClose]);
  assert.deepEqual(firstResult, { wasListening: true, drained: true });
  assert.deepEqual(secondResult, { wasListening: true, drained: true });
});

test('closeHttpServer resolves when closeIdleConnections is unavailable', async (t) => {
  const handlerEntered = createDeferred();
  const releaseHandler = createDeferred();
  const responseEnded = createDeferred();

  const server = http.createServer((_req, res) => {
    handlerEntered.resolve();
    void releaseHandler.promise.then(() => {
      res.writeHead(200);
      res.end('ok');
    });
  });
  await listen(server);
  const port = server.address().port;
  const requests = [];

  const request = http.get(`http://127.0.0.1:${port}/`, { agent: false }, (res) => {
    res.resume();
    res.on('end', () => responseEnded.resolve());
  });
  request.on('error', () => {});
  requests.push(request);
  registerHttpResources(t, { server, requests, releaseHandler });

  await handlerEntered.promise;
  delete server.closeIdleConnections;

  const closePromise = closeHttpServer(server);
  releaseHandler.resolve();
  await responseEnded.promise;

  assert.deepEqual(await closePromise, { wasListening: true, drained: true });
});

test('single idle sweep does not drain socket that becomes idle after drain starts', async () => {
  const fake = createFakeKeepAliveDrainServer();

  const closePromise = closeHttpServerSingleSweep(fake.server);
  fake.becomeIdle();

  let settled = false;
  void closePromise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'single sweep must remain pending after socket becomes idle');

  fake.server.closeIdleConnections();
  assert.deepEqual(await closePromise, { wasListening: true, drained: true });
});

test('repeated idle sweeps drain keep-alive socket that becomes idle after drain starts', async () => {
  const fake = createFakeKeepAliveDrainServer();

  const closePromise = closeHttpServer(fake.server);
  fake.becomeIdle();

  assert.deepEqual(
    await waitForDrain(closePromise),
    { wasListening: true, drained: true },
  );
});

test('production idle keep-alive sweep interval is unrefed', async () => {
  const originalSetInterval = global.setInterval;
  let capturedTimer = null;
  let unrefCalls = 0;
  global.setInterval = (...args) => {
    capturedTimer = originalSetInterval(...args);
    const originalUnref = capturedTimer.unref.bind(capturedTimer);
    capturedTimer.unref = () => {
      unrefCalls += 1;
      return originalUnref();
    };
    return capturedTimer;
  };
  try {
    let closeCallback = null;
    const server = {
      listening: true,
      close(callback) {
        closeCallback = callback;
      },
      closeIdleConnections() {},
    };
    const closePromise = closeHttpServer(server);
    assert.ok(capturedTimer);
    assert.equal(unrefCalls, 1);
    closeCallback();
    assert.deepEqual(await closePromise, { wasListening: true, drained: true });
  } finally {
    global.setInterval = originalSetInterval;
    if (capturedTimer) clearInterval(capturedTimer);
  }
});

test('real keep-alive server drain completes after in-flight response finishes', async (t) => {
  const handlerEntered = createDeferred();
  const releaseHandler = createDeferred();
  const responseEnded = createDeferred();

  const server = http.createServer((_req, res) => {
    handlerEntered.resolve();
    void releaseHandler.promise.then(() => {
      res.writeHead(200, { Connection: 'keep-alive' });
      res.end('ok');
    });
  });
  await listen(server);
  const port = server.address().port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const requests = [];

  const request = http.get(`http://127.0.0.1:${port}/`, { agent }, (res) => {
    res.resume();
    res.on('end', () => responseEnded.resolve());
  });
  request.on('error', () => {});
  requests.push(request);
  registerHttpResources(t, { server, agent, requests, releaseHandler });

  await handlerEntered.promise;

  const closePromise = closeHttpServer(server);
  releaseHandler.resolve();
  await responseEnded.promise;

  assert.deepEqual(await closePromise, { wasListening: true, drained: true });
});

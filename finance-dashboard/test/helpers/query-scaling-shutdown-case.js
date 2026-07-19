'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const {
  readAtomicJsonMarker,
  waitForAtomicJsonMarker,
} = require('./atomic-markers');

async function waitForScalingBarrierEntered(markerDir, { timeoutMs = 5_000 } = {}) {
  const entered = await waitForAtomicJsonMarker(markerDir, 'entered', { timeoutMs });
  assert.ok(entered, `query-scaling entered marker missing under ${markerDir}`);
  return entered;
}

async function waitForShutdownAbortRecorded(markerDir, { timeoutMs = 8_000 } = {}) {
  const abortMarker = await waitForAtomicJsonMarker(markerDir, 'abort-recorded', { timeoutMs });
  assert.ok(abortMarker, `graceful shutdown abort marker missing under ${markerDir}`);
  return abortMarker;
}

async function waitForChildExit(child, timeoutMs = 5_000) {
  if (child.exitCode != null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`server child did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function runGracefulShutdownInFlightReadCase({
  spawnQueryScalingServer,
  resetScalingState,
  accountCount = 6,
  fetchDelayMs = 80,
  t,
}) {
  const barrierDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-query-scaling-barrier-'));
  const cleanup = () => {
    fs.rmSync(barrierDir, { recursive: true, force: true });
  };
  if (t) t.after(cleanup);

  const { base, headers, port, child } = await spawnQueryScalingServer(t, {
    accountCount,
    rowsPerAccount: 40,
    fetchDelayMs,
    barrierDir,
  });
  await resetScalingState(base, headers);

  const readReq = http.request({
    hostname: '127.0.0.1',
    port,
    path: '/api/v1/transactions?start=2024-01-01&end=2024-12-31',
    method: 'GET',
    headers,
  }, (res) => {
    res.on('data', () => {});
  });
  readReq.on('error', () => {});
  readReq.end();

  await waitForScalingBarrierEntered(barrierDir, { timeoutMs: 5_000 });
  child.kill('SIGTERM');
  const abortMarker = await waitForShutdownAbortRecorded(barrierDir, { timeoutMs: 8_000 });
  assert.ok(abortMarker.abortCount >= 1);
  assert.equal(abortMarker.phase, 'graceful shutdown');
  readReq.destroy();
  await waitForChildExit(child, 5_000);
  const callsMarker = readAtomicJsonMarker(barrierDir, 'calls');
  assert.ok(callsMarker, `missing calls marker under ${barrierDir}`);
  assert.ok(Number.isFinite(callsMarker.count) && callsMarker.count >= 1);
  assert.ok(callsMarker.count <= accountCount + 1);

  if (!t) cleanup();
  return { abortMarker, callsMarker };
}

module.exports = {
  runGracefulShutdownInFlightReadCase,
  waitForChildExit,
  waitForScalingBarrierEntered,
  waitForShutdownAbortRecorded,
};

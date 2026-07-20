'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { startQueryScalingServer } = require('./helpers/query-scaling-ephemeral-server');
const { runGracefulShutdownInFlightReadCase } = require('./helpers/query-scaling-shutdown-case');

async function spawnQueryScalingServer(t, options = {}) {
  return startQueryScalingServer(t, {
    tempPrefix: 'darkfinances-query-scaling-stress-',
    accountCount: options.accountCount ?? 6,
    rowsPerAccount: options.rowsPerAccount ?? 40,
    fetchDelayMs: options.fetchDelayMs ?? 80,
    barrierDir: options.barrierDir ?? null,
  });
}

async function resetScalingState(base, headers) {
  const response = await fetch(`${base}/api/v1/test/query-scaling-reset`, { headers });
  if (response.status !== 200) {
    throw new Error(`query-scaling-reset failed: ${response.status}`);
  }
}

const STRESS_ENABLED = process.env.FINANCE_QUERY_SHUTDOWN_STRESS === '1';
const SERIAL_RUNS = Number.parseInt(process.env.FINANCE_QUERY_SHUTDOWN_STRESS_SERIAL || '100', 10);
const PARALLEL_RUNS = Number.parseInt(process.env.FINANCE_QUERY_SHUTDOWN_STRESS_PARALLEL || '100', 10);
const PARALLELISM = Number.parseInt(process.env.FINANCE_QUERY_SHUTDOWN_STRESS_WORKERS || '5', 10);

test('graceful shutdown in-flight read stress (serial)', {
  skip: !STRESS_ENABLED,
  timeout: 600_000,
}, async (t) => {
  for (let i = 0; i < SERIAL_RUNS; i += 1) {
    await t.test(`serial run ${i + 1}/${SERIAL_RUNS}`, async (sub) => {
      await runGracefulShutdownInFlightReadCase({
        spawnQueryScalingServer,
        resetScalingState,
        t: sub,
      });
    });
  }
});

test('graceful shutdown in-flight read stress (parallel)', {
  skip: !STRESS_ENABLED,
  timeout: 600_000,
}, async (t) => {
  let cursor = 0;
  async function worker(workerId) {
    while (cursor < PARALLEL_RUNS) {
      const index = cursor;
      cursor += 1;
      if (index >= PARALLEL_RUNS) break;
      await t.test(`parallel run ${index + 1}/${PARALLEL_RUNS} worker ${workerId}`, async (sub) => {
        await runGracefulShutdownInFlightReadCase({
          spawnQueryScalingServer,
          resetScalingState,
          t: sub,
        });
      });
    }
  }
  await Promise.all(Array.from({ length: PARALLELISM }, (_, workerId) => worker(workerId + 1)));
  assert.equal(cursor, PARALLEL_RUNS);
});

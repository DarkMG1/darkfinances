'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const {
  createClientAbortSignal,
  responseEndedSuccessfully,
} = require('../lib/client-abort-signal');
const {
  getQueryAbortSentinelSnapshot,
  resetQueryAbortSentinel,
} = require('../lib/query-abort-sentinel');

function mockReq(overrides = {}) {
  const req = new EventEmitter();
  req.aborted = false;
  req.complete = false;
  return Object.assign(req, overrides);
}

function mockRes(overrides = {}) {
  const res = new EventEmitter();
  res.writableFinished = false;
  res.finished = false;
  res.headersSent = false;
  return Object.assign(res, overrides);
}

test.beforeEach(() => {
  process.env.NODE_ENV = 'test';
  resetQueryAbortSentinel();
});

test('responseEndedSuccessfully recognizes a finished response', () => {
  assert.equal(responseEndedSuccessfully({ writableFinished: true }), true);
  assert.equal(responseEndedSuccessfully({ finished: true, headersSent: true }), true);
  assert.equal(responseEndedSuccessfully({ finished: true, headersSent: false }), false);
  assert.equal(responseEndedSuccessfully({ writableFinished: false }), false);
});

test('createClientAbortSignal aborts on req aborted and disposes listeners', () => {
  const req = mockReq();
  const res = mockRes();
  const handle = createClientAbortSignal(req, res);
  assert.equal(handle.signal.aborted, false);
  req.aborted = true;
  req.emit('aborted');
  assert.equal(handle.signal.aborted, true);
  handle.dispose();
  assert.equal(getQueryAbortSentinelSnapshot().listenersAttached, 3);
  assert.equal(getQueryAbortSentinelSnapshot().listenersDisposed, 3);
});

test('createClientAbortSignal aborts on res close before finish', () => {
  const req = mockReq();
  const res = mockRes();
  const handle = createClientAbortSignal(req, res);
  res.emit('close');
  assert.equal(handle.signal.aborted, true);
  handle.dispose();
});

test('createClientAbortSignal ignores res close after successful finish', () => {
  const req = mockReq();
  const res = mockRes();
  const handle = createClientAbortSignal(req, res);
  res.emit('finish');
  res.writableFinished = true;
  res.emit('close');
  assert.equal(handle.signal.aborted, false);
  handle.dispose();
});

test('createClientAbortSignal ignores req complete without aborted', () => {
  const req = mockReq();
  const res = mockRes();
  const handle = createClientAbortSignal(req, res);
  req.complete = true;
  req.emit('close');
  assert.equal(handle.signal.aborted, false);
  handle.dispose();
});

test('createClientAbortSignal is idempotent on repeated abort and dispose', () => {
  const req = mockReq();
  const res = mockRes();
  const handle = createClientAbortSignal(req, res);
  req.emit('aborted');
  req.emit('aborted');
  res.emit('close');
  assert.equal(handle.signal.aborted, true);
  handle.dispose();
  handle.dispose();
  assert.equal(getQueryAbortSentinelSnapshot().listenersDisposed, 3);
});

test('createClientAbortSignal external signal does not attach listeners', () => {
  const controller = new AbortController();
  const req = mockReq();
  const res = mockRes();
  const handle = createClientAbortSignal(req, res, { externalSignal: controller.signal });
  assert.equal(handle.ownsListeners, false);
  assert.equal(getQueryAbortSentinelSnapshot().listenersAttached, 0);
  controller.abort();
  assert.equal(handle.signal.aborted, true);
  handle.dispose();
  assert.equal(getQueryAbortSentinelSnapshot().listenersDisposed, 0);
});

test('createClientAbortSignal pre-aborted req aborts immediately', () => {
  const req = mockReq({ aborted: true });
  const res = mockRes();
  const handle = createClientAbortSignal(req, res);
  assert.equal(handle.signal.aborted, true);
  handle.dispose();
});

test('many create/dispose cycles do not leak req/res listeners', () => {
  const req = mockReq();
  const res = mockRes();
  req.setMaxListeners(4);
  res.setMaxListeners(6);
  for (let i = 0; i < 50; i++) {
    const handle = createClientAbortSignal(req, res);
    handle.dispose();
  }
  assert.equal(req.listenerCount('aborted'), 0);
  assert.equal(res.listenerCount('finish'), 0);
  assert.equal(res.listenerCount('close'), 0);
});

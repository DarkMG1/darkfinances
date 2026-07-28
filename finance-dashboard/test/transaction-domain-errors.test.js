'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SplitLegDeleteError,
  SplitParentNotFoundError,
  ManualAssetNotFoundError,
  GoalLinkedAccountNotFoundError,
  GoalLinkedAccountClosedError,
  KnownPreApplyError,
} = require('../lib/errors');
const { apiErrorBody } = require('../lib/request-envelope');

const req = { requestId: 'req-domain-001' };

test('split leg delete route envelope exposes safe 400 domain error', () => {
  const body = apiErrorBody(new SplitLegDeleteError(), req).body;
  assert.equal(body.code, 'INVALID_REQUEST');
  assert.equal(body.error, 'Split legs cannot be deleted independently');
  assert.equal(body.requestId, req.requestId);
});

test('split parent not found route envelope exposes safe 404 domain error', () => {
  const body = apiErrorBody(new SplitParentNotFoundError(), req).body;
  assert.equal(body.code, 'NOT_FOUND');
  assert.equal(body.error, 'Split parent not found');
  assert.equal(body.requestId, req.requestId);
});

test('manual asset and goal link domain errors are KnownPreApplyError with legacy envelopes', () => {
  for (const error of [
    new ManualAssetNotFoundError(),
    new GoalLinkedAccountNotFoundError(),
    new GoalLinkedAccountClosedError(),
  ]) {
    assert.ok(error instanceof KnownPreApplyError);
    const body = apiErrorBody(error, req).body;
    assert.equal(body.code, error.code);
    assert.equal(body.error, error.message);
    assert.equal(body.requestId, req.requestId);
  }
  assert.equal(new ManualAssetNotFoundError().status, 404);
  assert.equal(new GoalLinkedAccountNotFoundError().status, 404);
  assert.equal(new GoalLinkedAccountClosedError().status, 409);
});

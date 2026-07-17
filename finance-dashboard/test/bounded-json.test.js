const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const {
  MalformedJsonError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  boundedJsonMiddleware,
  parseBoundedJson,
  readBoundedBody,
} = require('../lib/bounded-json');
const {
  RECEIPT_MAX_BASE64_CHARS,
  RECEIPT_MAX_DECODED_BYTES,
  assertReceiptEncodedWithinLimits,
  exactBase64DecodedBytes,
} = require('../lib/receipt-limits');

function mockReq(chunks, headers = {}) {
  const req = new EventEmitter();
  req.headers = headers;
  req.method = headers.__method || 'POST';
  req.get = (name) => {
    const key = String(name).toLowerCase();
    return req.headers[key] ?? req.headers[name];
  };
  req.destroy = () => {};
  queueMicrotask(() => {
    for (const chunk of chunks) req.emit('data', chunk);
    req.emit('end');
  });
  return req;
}

function mockRes() {
  const res = {};
  res.statusCode = 200;
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

test('parseBoundedJson rejects malformed and truncated JSON deterministically', () => {
  for (const sample of ['{', '{"a":', '{"a":1', '[1]', 'null', '"x"']) {
    assert.throws(() => parseBoundedJson(Buffer.from(sample)), MalformedJsonError);
  }
  assert.deepEqual(parseBoundedJson(Buffer.alloc(0)), {});
  assert.deepEqual(parseBoundedJson(Buffer.from('{"ok":true}')), { ok: true });
});

test('readBoundedBody treats Content-Length 0 as empty when stream is empty', async () => {
  const body = await readBoundedBody(mockReq([], { 'content-length': '0' }), 16);
  assert.equal(body.length, 0);
});

test('readBoundedBody rejects bytes smuggled against Content-Length 0', async () => {
  await assert.rejects(
    () => readBoundedBody(mockReq([Buffer.from('{}')], { 'content-length': '0' }), 16),
    (error) => error instanceof MalformedJsonError
      && /empty when Content-Length is 0/i.test(error.message),
  );
});

test('readBoundedBody rejects body chunks beyond declared Content-Length', async () => {
  await assert.rejects(
    () => readBoundedBody(mockReq([Buffer.from('{"a":1}')], { 'content-length': '4' }), 16),
    (error) => error instanceof MalformedJsonError
      && /Content-Length/i.test(error.message),
  );
});

test('readBoundedBody enforces declared and streaming byte limits', async () => {
  await assert.rejects(
    () => readBoundedBody(mockReq([], { 'content-length': '9' }), 8),
    PayloadTooLargeError,
  );
  const body = await readBoundedBody(mockReq([Buffer.from('{"a":1}')], {}), 16);
  assert.equal(body.toString(), '{"a":1}');
  await assert.rejects(
    () => readBoundedBody(mockReq([Buffer.alloc(9)], {}), 8),
    PayloadTooLargeError,
  );
});

test('bounded JSON middleware accepts DELETE bodies and rejects gzip encoding', async () => {
  const deleteBody = Buffer.from('{"inflowId":"a","expenseId":"b"}');
  const req = mockReq([deleteBody], { __method: 'DELETE', 'content-type': 'application/json' });
  const res = mockRes();
  let nextError;
  await new Promise((resolve) => {
    boundedJsonMiddleware({ limit: 1024 })(req, res, (error) => {
      nextError = error;
      resolve();
    });
  });
  assert.equal(nextError, undefined);
  assert.deepEqual(req.body, { inflowId: 'a', expenseId: 'b' });

  const gzipReq = mockReq([], { 'content-encoding': 'gzip' });
  await new Promise((resolve) => {
    boundedJsonMiddleware({ limit: 1024 })(gzipReq, mockRes(), (error) => {
      assert.ok(error instanceof UnsupportedMediaTypeError);
      resolve();
    });
  });
});

test('Content-Length 0 consumes stream and yields empty JSON object through middleware', async () => {
  const req = mockReq([], { 'content-length': '0', __method: 'POST' });
  await new Promise((resolve) => {
    boundedJsonMiddleware({ limit: 1024 })(req, mockRes(), (error) => {
      assert.equal(error, undefined);
      assert.deepEqual(req.body, {});
      assert.equal(req.rawBody.length, 0);
      resolve();
    });
  });
});

test('receipt encoded/decoded boundaries are aligned', () => {
  const atLimit = Buffer.alloc(RECEIPT_MAX_DECODED_BYTES).toString('base64');
  assert.equal(atLimit.length, RECEIPT_MAX_BASE64_CHARS);
  assert.ok(exactBase64DecodedBytes(atLimit) <= RECEIPT_MAX_DECODED_BYTES);
  assert.throws(
    () => assertReceiptEncodedWithinLimits(Buffer.alloc(RECEIPT_MAX_DECODED_BYTES + 1).toString('base64')),
    PayloadTooLargeError,
  );
});

test('unsupported media type error is stable', () => {
  const error = new UnsupportedMediaTypeError();
  assert.equal(error.code, 'UNSUPPORTED_MEDIA_TYPE');
  assert.equal(error.status, 415);
});

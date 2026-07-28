'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  DEBUG_BODY,
  MAX_ERROR_BODY_BYTES,
  SplitwiseRequestError,
  assertSplitwiseOk,
  cancelResponseBody,
  extractAllowlistedCode,
  readBoundedResponseText,
  resolveMaxErrorBodyBytes,
  sanitizeHeaderValue,
  splitwiseResponseError,
} = require('../lib/splitwise-errors');

const toolsRoot = path.resolve(__dirname, '..');

const PII_BODY = {
  errors: {
    base: ['invalid_grant'],
    oauth: ['client_secret mismatch for sk_live_SUPERSECRET'],
  },
  user: {
    id: 987654,
    first_name: 'Alice',
    last_name: 'Example',
    email: 'alice@example.com',
  },
  access_token: 'swtok_abcdefghijklmnopqrstuvwxyz',
  request: {
    client_id: 'consumer-key-leak',
    client_secret: 'consumer-secret-leak',
  },
};

function jsonResponse(body, { status = 403, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

function createTrackingStream(fullText, chunkSize = 128) {
  let offset = 0;
  let readCount = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      readCount += 1;
      if (offset >= fullText.length) {
        controller.close();
        return;
      }
      const chunk = fullText.slice(offset, offset + chunkSize);
      offset += chunk.length;
      controller.enqueue(new TextEncoder().encode(chunk));
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    getReadCount: () => readCount,
    wasCancelled: () => cancelled,
    bytesConsumed: () => offset,
  };
}

test('splitwise error messages omit response bodies, names, ids, and tokens by default', async () => {
  const response = jsonResponse(PII_BODY, {
    headers: {
      'retry-after': '60',
      'x-request-id': 'req-safe-123',
    },
  });
  const error = await splitwiseResponseError(response, { endpoint: 'get_expenses', method: 'GET' });
  assert.ok(error instanceof SplitwiseRequestError);
  assert.match(error.message, /Splitwise get_expenses request failed/);
  assert.match(error.message, /status=403/);
  assert.match(error.message, /code=invalid_grant/);
  assert.match(error.message, /retry-after=60/);
  assert.match(error.message, /request-id=req-safe-123/);
  assert.doesNotMatch(error.message, /Alice/);
  assert.doesNotMatch(error.message, /alice@example.com/);
  assert.doesNotMatch(error.message, /987654/);
  assert.doesNotMatch(error.message, /swtok_/);
  assert.doesNotMatch(error.message, /consumer-secret-leak/);
  assert.doesNotMatch(error.message, /client_id/);
  assert.equal(error.debugBody, undefined);
});

test('bounded stream reader stops at configured bytes and cancels without consuming tail chunks', async () => {
  const head = 'H'.repeat(400);
  const tail = `${'T'.repeat(4000)}TAIL_NOT_READ`;
  const tracking = createTrackingStream(`${head}${tail}`, 100);
  const response = new Response(tracking.stream, { status: 500, headers: { 'content-type': 'text/plain' } });
  const { text, stats } = await readBoundedResponseText(response, 512);
  assert.equal(text.length, 512);
  assert.equal(text, `${head}${'T'.repeat(112)}`);
  assert.doesNotMatch(text, /TAIL_NOT_READ/);
  assert.ok(stats.readCount >= 1);
  assert.equal(stats.cancelled, true);
  assert.ok(tracking.wasCancelled());
  assert.ok(tracking.bytesConsumed() <= 512 + 100);
  assert.ok(tracking.bytesConsumed() < head.length + tail.length);
});

test('readBoundedResponseText fallback honors hard byte bound for body-less test doubles', async () => {
  const huge = `${'x'.repeat(900)}FALLBACK_TAIL`;
  const { text, stats } = await readBoundedResponseText({ _bodyText: huge }, 64);
  assert.equal(text.length, 64);
  assert.doesNotMatch(text, /FALLBACK_TAIL/);
  assert.equal(stats.readCount, 1);
});

test('oversized error bodies are parsed with a bounded byte limit', async () => {
  const huge = `${'x'.repeat(MAX_ERROR_BODY_BYTES + 4000)}TOKEN_SHOULD_NOT_APPEAR`;
  const boundedResponse = new Response(huge, { status: 500, headers: { 'content-type': 'text/plain' } });
  const { text: bounded } = await readBoundedResponseText(boundedResponse);
  assert.equal(bounded.length, MAX_ERROR_BODY_BYTES);
  assert.doesNotMatch(bounded, /TOKEN_SHOULD_NOT_APPEAR/);

  const errorResponse = new Response(huge, { status: 500, headers: { 'content-type': 'text/plain' } });
  const error = await splitwiseResponseError(errorResponse, { endpoint: 'get_groups' });
  assert.match(error.message, /code=server_error/);
  assert.doesNotMatch(error.message, /TOKEN_SHOULD_NOT_APPEAR/);
});

test('resolveMaxErrorBodyBytes clamps to 64..4096 with deterministic default', () => {
  assert.equal(resolveMaxErrorBodyBytes(undefined), 512);
  assert.equal(resolveMaxErrorBodyBytes(''), 512);
  assert.equal(resolveMaxErrorBodyBytes('not-a-number'), 512);
  assert.equal(resolveMaxErrorBodyBytes('32'), 64);
  assert.equal(resolveMaxErrorBodyBytes('99999'), 4096);
  assert.equal(resolveMaxErrorBodyBytes('256'), 256);
});

test('sanitizeHeaderValue strips controls and truncates to 128 printable chars', () => {
  assert.equal(sanitizeHeaderValue('req-123'), 'req-123');
  assert.equal(sanitizeHeaderValue('a\nb\rc'), 'abc');
  assert.equal(sanitizeHeaderValue(`x${'y'.repeat(200)}`), `x${'y'.repeat(127)}`);
  assert.equal(sanitizeHeaderValue('\x00\x1f'), null);
});

test('retry-after and request-id in error messages are sanitized', async () => {
  const poison = `60${'\x07'.repeat(10)}${'z'.repeat(200)}`;
  const response = jsonResponse({ error: 'rate_limit_exceeded' }, {
    status: 429,
    headers: {
      'retry-after': poison,
      'x-request-id': poison,
    },
  });
  const error = await splitwiseResponseError(response, { endpoint: 'get_expenses' });
  assert.ok(error.retryAfter.length <= 128);
  assert.ok(error.requestId.length <= 128);
  assert.doesNotMatch(error.message, /\x07/);
});

test('assertSplitwiseOk preserves successful JSON responses', async () => {
  const payload = { expenses: [{ id: 1, description: 'Dinner with Alice' }] };
  const response = jsonResponse(payload, { status: 200 });
  const ok = await assertSplitwiseOk(response, { endpoint: 'get_expenses' });
  assert.equal(ok, response);
  const parsed = await ok.json();
  assert.deepEqual(parsed, payload);
});

test('debug response bodies require explicit opt-in and stay hidden from serialization', async (t) => {
  t.after(() => {
    delete process.env.SPLITWISE_DEBUG_RESPONSE_BODY;
  });
  process.env.SPLITWISE_DEBUG_RESPONSE_BODY = '1';
  const response = jsonResponse({ error: 'unauthorized', note: 'token abc123' }, { status: 401 });
  const error = await splitwiseResponseError(response, { endpoint: 'oauth/token', method: 'POST' });
  assert.equal(typeof error.debugBody, 'string');
  assert.match(error.debugBody, /abc123/);
  assert.doesNotMatch(error.message, /abc123/);
  assert.doesNotMatch(JSON.stringify(error), /abc123/);
  assert.doesNotMatch(util.inspect(error), /abc123/);
  assert.equal(Object.prototype.propertyIsEnumerable.call(error, DEBUG_BODY), false);
  assert.equal('debugBody' in error, true);
});

test('debugBody is not attached when debug opt-in is off', async () => {
  delete process.env.SPLITWISE_DEBUG_RESPONSE_BODY;
  const response = jsonResponse({ error: 'forbidden', note: 'secret-body' }, { status: 403 });
  const error = await splitwiseResponseError(response, { endpoint: 'get_groups' });
  assert.equal(error.debugBody, undefined);
  assert.equal(error[DEBUG_BODY], undefined);
  assert.doesNotMatch(JSON.stringify(error), /secret-body/);
});

test('extractAllowlistedCode ignores unknown free-text error payloads', () => {
  assert.equal(extractAllowlistedCode(JSON.stringify({ errors: { base: ['contact support with user id 42'] } })), null);
  assert.equal(extractAllowlistedCode(JSON.stringify({ error: 'forbidden' })), 'forbidden');
});

test('cancelResponseBody cancels readable streams', async () => {
  const tracking = createTrackingStream('abcdefghijklmnop', 4);
  const response = new Response(tracking.stream, { status: 503 });
  await cancelResponseBody(response);
  assert.equal(tracking.wasCancelled(), true);
});

test('splitwise-lib surfaces SplitwiseRequestError without leaking response bodies', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    delete process.env.SPLITWISE_API_KEY;
  });
  process.env.SPLITWISE_API_KEY = 'test-key';
  global.fetch = async () => jsonResponse({
    errors: { base: ['forbidden'] },
    user: { first_name: 'Alice', email: 'alice@example.com' },
    access_token: 'swtok_leak',
  }, { status: 403 });

  const { swApi } = require('../splitwise-lib');
  await assert.rejects(
    () => swApi('test-key', 'get_groups'),
    (error) => {
      assert.ok(error instanceof SplitwiseRequestError);
      assert.match(error.message, /Splitwise get_groups request failed/);
      assert.doesNotMatch(error.message, /Alice/);
      assert.doesNotMatch(error.message, /swtok_leak/);
      assert.doesNotMatch(JSON.stringify(error), /alice@example.com/);
      return true;
    },
  );
});

test('fetchWithRetry drains retryable bodies and returns terminal failures to assertSplitwiseOk', async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  let firstTracking;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      firstTracking = createTrackingStream(`${'R'.repeat(3000)}RETRY_TAIL`, 150);
      return new Response(firstTracking.stream, { status: 503, headers: { 'content-type': 'text/plain' } });
    }
    return jsonResponse({ error: 'server_error', secret: 'FINAL_LEAK' }, { status: 503 });
  };

  const { fetchWithRetry } = require('../splitwise-lib');
  const response = await fetchWithRetry('https://secure.splitwise.com/api/v3.0/get_groups', {}, 2);
  assert.equal(calls, 2);
  assert.equal(firstTracking.wasCancelled(), true);
  assert.ok(firstTracking.bytesConsumed() < 3000);
  await assert.rejects(
    () => assertSplitwiseOk(response, { endpoint: 'get_groups' }),
    (error) => {
      assert.ok(error instanceof SplitwiseRequestError);
      assert.match(error.message, /code=server_error/);
      assert.doesNotMatch(error.message, /FINAL_LEAK/);
      return true;
    },
  );
});

test('fetchWithRetry preserves final retryable response body for bounded machine-code parsing', async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  let firstTracking;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      firstTracking = createTrackingStream(`${'I'.repeat(3000)}INTERMEDIATE_TAIL`, 150);
      return new Response(firstTracking.stream, { status: 503, headers: { 'content-type': 'text/plain' } });
    }
    return jsonResponse({
      errors: { oauth: ['invalid_grant'] },
      secret: 'FINAL_BODY_LEAK',
    }, { status: 503 });
  };

  const { fetchWithRetry } = require('../splitwise-lib');
  const response = await fetchWithRetry('https://secure.splitwise.com/api/v3.0/oauth/token', {}, 2);
  assert.equal(calls, 2);
  assert.equal(firstTracking.wasCancelled(), true);
  await assert.rejects(
    () => assertSplitwiseOk(response, { endpoint: 'oauth/token', method: 'POST' }),
    (error) => {
      assert.ok(error instanceof SplitwiseRequestError);
      assert.match(error.message, /code=invalid_grant/);
      assert.doesNotMatch(error.message, /code=server_error/);
      assert.doesNotMatch(error.message, /FINAL_BODY_LEAK/);
      return true;
    },
  );
});

test('fetchWithRetry timeout errors stay stable and non-sensitive', async (t) => {
  const originalFetch = global.fetch;
  const splitwiseLibPath = require.resolve('../splitwise-lib');
  t.after(() => {
    global.fetch = originalFetch;
    delete process.env.SPLITWISE_TIMEOUT_MS;
    delete require.cache[splitwiseLibPath];
  });
  delete require.cache[splitwiseLibPath];
  process.env.SPLITWISE_TIMEOUT_MS = '50';
  global.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });

  const { fetchWithRetry } = require('../splitwise-lib');
  await assert.rejects(
    () => fetchWithRetry('https://secure.splitwise.com/api/v3.0/get_groups', {}, 1),
    (error) => {
      assert.match(error.message, /Splitwise request timed out after 50ms/);
      assert.doesNotMatch(error.message, /secure\.splitwise/);
      return true;
    },
  );
});

test('splitwise token failure script stderr omits response bodies and tokens', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'splitwise-error-script-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(toolsRoot, 'lib'), path.join(dir, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(toolsRoot, 'splitwise-lib.js'), path.join(dir, 'splitwise-lib.js'));
  fs.writeFileSync(path.join(dir, 'probe.js'), `
global.fetch = async () => new Response(JSON.stringify({
  errors: { base: ['invalid_grant'] },
  user: { first_name: 'Alice', email: 'alice@example.com' },
  access_token: 'swtok_script_leak',
}), { status: 403, headers: { 'content-type': 'application/json' } });
const { getToken } = require('./splitwise-lib');
getToken().then(() => process.exit(2)).catch((error) => {
  console.error('ERR', error && error.stack ? error.stack : error);
  process.exit(1);
});
`);

  const result = spawnSync(process.execPath, [path.join(dir, 'probe.js')], {
    cwd: dir,
    env: {
      ...process.env,
      SPLITWISE_CONSUMER_KEY: 'consumer-key',
      SPLITWISE_CONSUMER_SECRET: 'consumer-secret',
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Splitwise oauth\/token request failed/);
  assert.doesNotMatch(result.stderr, /Alice/);
  assert.doesNotMatch(result.stderr, /alice@example.com/);
  assert.doesNotMatch(result.stderr, /swtok_script_leak/);
});

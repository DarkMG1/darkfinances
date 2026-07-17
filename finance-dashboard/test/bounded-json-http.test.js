const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const {
  boundedJsonMiddleware,
} = require('../lib/bounded-json');

function withJsonBodyParser() {
  const parse = boundedJsonMiddleware({ limit: 1024 });
  return (req, res, next) => {
    Promise.resolve(parse(req, res, next)).catch(next);
  };
}

test('raw HTTP CL:0 and chunked requests parse without hanging', async (t) => {
  const app = http.createServer((req, res) => {
    withJsonBodyParser()(req, res, (error) => {
      if (error) {
        res.statusCode = error.status || 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ code: error.code, error: error.message }));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.body));
    });
  });

  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const { port } = app.address();

  const clZero = await Promise.race([
    new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/',
        headers: { 'Content-Length': '0' },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }));
      });
      req.on('error', reject);
      req.end();
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('CL:0 request timed out')), 5000)),
  ]);
  assert.equal(clZero.status, 200);
  assert.deepEqual(clZero.body, {});

  const chunked = await Promise.race([
    new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/',
        headers: {
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }));
      });
      req.on('error', reject);
      req.write('{"chunked":true}');
      req.end();
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('chunked request timed out')), 5000)),
  ]);
  assert.equal(chunked.status, 200);
  assert.deepEqual(chunked.body, { chunked: true });
});

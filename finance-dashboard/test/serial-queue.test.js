const test = require('node:test');
const assert = require('node:assert/strict');
const { SerialQueue } = require('../lib/serial-queue');

test('runs asynchronous mutations strictly in submission order', async () => {
  const queue = new SerialQueue('writes');
  const events = [];
  const first = queue.run(async () => {
    events.push('first:start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push('first:end');
    return 1;
  });
  const second = queue.run(async () => {
    events.push('second:start');
    events.push('second:end');
    return 2;
  });

  assert.equal(queue.size, 2);
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
  await queue.tail;
  assert.equal(queue.size, 0);
});

test('a rejected mutation does not poison later work', async () => {
  const queue = new SerialQueue('writes');
  const failed = queue.run(async () => {
    throw new Error('expected');
  });
  const recovered = queue.run(async () => 'ok');

  await assert.rejects(failed, /expected/);
  assert.equal(await recovered, 'ok');
});

test('serial queue close rejects new work with typed unavailable error', async () => {
  const queue = new SerialQueue('writes');
  queue.close();
  const { AdmissionUnavailableError } = require('../lib/errors');
  await assert.rejects(queue.run(async () => {}), AdmissionUnavailableError);
});

test('close rejects new work while drain waits for accepted work', async () => {
  const queue = new SerialQueue('writes');
  let finished = false;
  queue.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    finished = true;
  });
  queue.close();
  const { AdmissionUnavailableError } = require('../lib/errors');
  await assert.rejects(queue.run(async () => {}), AdmissionUnavailableError);
  await queue.drain(100);
  assert.equal(finished, true);
  assert.equal(queue.size, 0);
});

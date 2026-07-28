'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_TTL_MS,
  resetPasskeyChallengeGuard,
  tryConsumePasskeyChallenge,
} = require('../lib/passkey-challenge-guard');

function deferred() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

test('challenge guard rejects duplicate consumption for same session/kind/challenge', () => {
  resetPasskeyChallengeGuard();
  const args = { sessionId: 'sess-1', kind: 'login', challenge: 'abc123' };
  assert.equal(tryConsumePasskeyChallenge(args), true);
  assert.equal(tryConsumePasskeyChallenge(args), false);
});

test('challenge guard evicts expired entries', () => {
  resetPasskeyChallengeGuard();
  const now = Date.now();
  assert.equal(tryConsumePasskeyChallenge({
    sessionId: 'sess-expire',
    kind: 'register',
    challenge: 'old',
    ttlMs: 1,
    now,
  }), true);
  assert.equal(tryConsumePasskeyChallenge({
    sessionId: 'sess-expire',
    kind: 'register',
    challenge: 'old',
    ttlMs: 1,
    now: now + 2,
  }), true);
});

test('parallel deferred finish allows exactly one verification attempt', async () => {
  resetPasskeyChallengeGuard();
  const sessionId = 'sess-parallel';
  const challenge = 'shared-challenge';
  let verifyCalls = 0;
  const verifyGate = deferred();

  async function finishAttempt() {
    if (!tryConsumePasskeyChallenge({ sessionId, kind: 'login', challenge })) {
      return 'rejected';
    }
    await verifyGate.promise;
    verifyCalls += 1;
    return 'success';
  }

  const first = finishAttempt();
  const second = finishAttempt();
  verifyGate.release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.sort(), ['rejected', 'success']);
  assert.equal(verifyCalls, 1);
});

test('parallel deferred finish for counterless credentials still verifies once', async () => {
  resetPasskeyChallengeGuard();
  const sessionId = 'sess-zero';
  const challenge = 'zero-counter-challenge';
  let verifyCalls = 0;
  const verifyGate = deferred();

  async function finishAttempt(newCounter) {
    if (!tryConsumePasskeyChallenge({ sessionId, kind: 'login', challenge })) {
      return { status: 'rejected', counter: newCounter };
    }
    await verifyGate.promise;
    verifyCalls += 1;
    return { status: 'success', counter: newCounter };
  }

  const first = finishAttempt(0);
  const second = finishAttempt(0);
  verifyGate.release();
  const results = await Promise.all([first, second]);
  const statuses = results.map((entry) => entry.status).sort();
  assert.deepEqual(statuses, ['rejected', 'success']);
  assert.equal(verifyCalls, 1);
});

test('guard default ttl matches expected WebAuthn finish window', () => {
  assert.equal(DEFAULT_TTL_MS, 10 * 60 * 1000);
});

test('challenge guard fails closed when capacity is full', () => {
  resetPasskeyChallengeGuard();
  const now = Date.now();
  for (let i = 0; i < 3; i += 1) {
    assert.equal(tryConsumePasskeyChallenge({
      sessionId: `sess-cap-${i}`,
      kind: 'login',
      challenge: `challenge-${i}`,
      maxEntries: 3,
      now,
    }), true);
  }
  assert.equal(tryConsumePasskeyChallenge({
    sessionId: 'sess-cap-overflow',
    kind: 'login',
    challenge: 'overflow-challenge',
    maxEntries: 3,
    now,
  }), false);
});

test('challenge guard prunes expired entries before enforcing capacity', () => {
  resetPasskeyChallengeGuard();
  const now = Date.now();
  assert.equal(tryConsumePasskeyChallenge({
    sessionId: 'sess-expire-a',
    kind: 'login',
    challenge: 'slot-a',
    ttlMs: 1,
    maxEntries: 1,
    now,
  }), true);
  assert.equal(tryConsumePasskeyChallenge({
    sessionId: 'sess-expire-b',
    kind: 'login',
    challenge: 'slot-b',
    ttlMs: 60_000,
    maxEntries: 1,
    now: now + 2,
  }), true);
  assert.equal(tryConsumePasskeyChallenge({
    sessionId: 'sess-expire-b',
    kind: 'login',
    challenge: 'slot-b',
    ttlMs: 60_000,
    maxEntries: 1,
    now: now + 2,
  }), false);
});

test('challenge guard never evicts unexpired consumed entries', () => {
  resetPasskeyChallengeGuard();
  const now = Date.now();
  const args = { sessionId: 'sess-protected', kind: 'register', challenge: 'protected-challenge', maxEntries: 1, now };
  assert.equal(tryConsumePasskeyChallenge(args), true);
  assert.equal(tryConsumePasskeyChallenge({
    sessionId: 'sess-other',
    kind: 'register',
    challenge: 'other-challenge',
    maxEntries: 1,
    now,
  }), false);
  assert.equal(tryConsumePasskeyChallenge(args), false);
});

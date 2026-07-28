'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  applyAuthenticationCounterUpdate,
  isPasskeyRuntimeStoreError,
  loadPasskeyCredentials,
  mergeRegistrationCredential,
  PASSKEY_CREDENTIALS_DEPLOYMENT_CONTRACT,
  resetPasskeyTransactionQueues,
  resetWriteGuards,
  savePasskeyCredentials,
  withPasskeyCredentialsTransaction,
} = require('../lib/passkey-credentials-store');
const { RuntimeStateError } = require('../lib/runtime-state-store');

function makeCred(id, counter = 0) {
  return {
    credentialID: id,
    credentialPublicKey: Buffer.from(`public-${id}`).toString('base64'),
    counter,
    transports: ['internal'],
    createdAt: '2026-07-13T00:00:00.000Z',
    lastUsedAt: null,
  };
}

function deferred() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

test('runtime store errors are identifiable for generic 500 handling', () => {
  assert.equal(isPasskeyRuntimeStoreError(new RuntimeStateError('disk full', {
    code: 'RUNTIME_STATE_WRITE_INVALID',
  })), true);
  assert.equal(isPasskeyRuntimeStoreError(new Error('verification failed')), false);
});

test('documents single-process writer deployment contract', () => {
  assert.equal(PASSKEY_CREDENTIALS_DEPLOYMENT_CONTRACT.id, 'single-process-writer');
  assert.match(PASSKEY_CREDENTIALS_DEPLOYMENT_CONTRACT.requirement, /One finance-dashboard process/);
});

test('parallel enrollments with deferred verification retain both credentials', async (t) => {
  resetWriteGuards();
  resetPasskeyTransactionQueues();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-concurrency-'));
  const file = path.join(dir, 'passkey-credentials.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const firstGate = deferred();
  const secondGate = deferred();
  const firstStarted = deferred();
  const secondStarted = deferred();

  const first = withPasskeyCredentialsTransaction(file, async (creds) => {
    firstStarted.release();
    await firstGate.promise;
    mergeRegistrationCredential(creds, makeCred('cred-a'));
  });
  await firstStarted.promise;

  const second = withPasskeyCredentialsTransaction(file, async (creds) => {
    secondStarted.release();
    await secondGate.promise;
    mergeRegistrationCredential(creds, makeCred('cred-b'));
  });

  firstGate.release();
  await first;
  await secondStarted.promise;
  secondGate.release();
  await second;

  const stored = loadPasskeyCredentials(file);
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map((entry) => entry.credentialID).sort(), ['cred-a', 'cred-b']);
});

test('counterless authenticators accept repeated zero counters and update lastUsedAt', async () => {
  resetWriteGuards();
  resetPasskeyTransactionQueues();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-zero-counter-'));
  const file = path.join(dir, 'passkey-credentials.json');
  try {
    savePasskeyCredentials([makeCred('cred-a', 0)], file);
    await withPasskeyCredentialsTransaction(file, async (creds) => {
      applyAuthenticationCounterUpdate(creds, 'cred-a', 0);
    });
    const first = loadPasskeyCredentials(file)[0];
    assert.equal(first.counter, 0);
    assert.ok(first.lastUsedAt);

    await withPasskeyCredentialsTransaction(file, async (creds) => {
      applyAuthenticationCounterUpdate(creds, 'cred-a', 0);
    });
    const second = loadPasskeyCredentials(file)[0];
    assert.equal(second.counter, 0);
    assert.ok(second.lastUsedAt);
    assert.notEqual(second.lastUsedAt, first.lastUsedAt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('authentication counter updates are monotonic and reject replays', async () => {
  resetWriteGuards();
  resetPasskeyTransactionQueues();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-counter-'));
  const file = path.join(dir, 'passkey-credentials.json');
  try {
    savePasskeyCredentials([makeCred('cred-a', 5)], file);

    await withPasskeyCredentialsTransaction(file, async (creds) => {
      applyAuthenticationCounterUpdate(creds, 'cred-a', 6);
    });
    assert.equal(loadPasskeyCredentials(file)[0].counter, 6);

    await assert.rejects(
      () => withPasskeyCredentialsTransaction(file, async (creds) => {
        applyAuthenticationCounterUpdate(creds, 'cred-a', 6);
      }),
      (error) => error.code === 'PASSKEY_COUNTER_REPLAY',
    );
    assert.equal(loadPasskeyCredentials(file)[0].counter, 6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stale concurrent authentication reads cannot accept duplicate counters', async () => {
  resetWriteGuards();
  resetPasskeyTransactionQueues();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-stale-'));
  const file = path.join(dir, 'passkey-credentials.json');
  try {
    savePasskeyCredentials([makeCred('cred-a', 3)], file);

    const firstGate = deferred();
    const secondGate = deferred();
    const firstLoaded = deferred();
    const secondLoaded = deferred();

    const first = withPasskeyCredentialsTransaction(file, async (creds) => {
      firstLoaded.release();
      await firstGate.promise;
      applyAuthenticationCounterUpdate(creds, 'cred-a', 4);
    });
    await firstLoaded.promise;

    const second = withPasskeyCredentialsTransaction(file, async (creds) => {
      secondLoaded.release();
      await secondGate.promise;
      applyAuthenticationCounterUpdate(creds, 'cred-a', 4);
    });

    firstGate.release();
    await first;
    await secondLoaded.promise;
    secondGate.release();
    await assert.rejects(second, (error) => error.code === 'PASSKEY_COUNTER_REPLAY');
    assert.equal(loadPasskeyCredentials(file)[0].counter, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('write failure leaves prior valid passkey state intact', async (t) => {
  resetWriteGuards();
  resetPasskeyTransactionQueues();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-write-fail-'));
  const file = path.join(dir, 'passkey-credentials.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  savePasskeyCredentials([makeCred('cred-a', 1)], file);
  const before = fs.readFileSync(file, 'utf8');

  const originalRename = fs.renameSync;
  fs.renameSync = (...args) => {
    if (String(args[0]).includes('.tmp')) {
      throw new Error('injected rename failure');
    }
    return originalRename(...args);
  };
  t.after(() => {
    fs.renameSync = originalRename;
  });

  await assert.rejects(
    () => withPasskeyCredentialsTransaction(file, async (creds) => {
      applyAuthenticationCounterUpdate(creds, 'cred-a', 2);
    }),
    RuntimeStateError,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(loadPasskeyCredentials(file)[0].counter, 1);
});

test('fsync failure leaves prior valid passkey state intact', (t) => {
  resetWriteGuards();
  resetPasskeyTransactionQueues();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-fsync-fail-'));
  const file = path.join(dir, 'passkey-credentials.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  savePasskeyCredentials([makeCred('cred-a', 1)], file);
  const before = fs.readFileSync(file, 'utf8');

  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = () => {
    throw new Error('injected fsync failure');
  };
  t.after(() => {
    fs.fsyncSync = originalFsync;
  });

  assert.throws(
    () => savePasskeyCredentials([makeCred('cred-a', 2)], file),
    RuntimeStateError,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(loadPasskeyCredentials(file)[0].counter, 1);
});

test('content write failure leaves prior valid passkey state intact', (t) => {
  resetWriteGuards();
  resetPasskeyTransactionQueues();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-passkey-write-sync-fail-'));
  const file = path.join(dir, 'passkey-credentials.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  savePasskeyCredentials([makeCred('cred-a', 1)], file);
  const before = fs.readFileSync(file, 'utf8');

  assert.throws(
    () => savePasskeyCredentials([makeCred('cred-a', 2)], file, {
      writeFileSync: () => {
        throw new Error('injected write failure');
      },
    }),
    RuntimeStateError,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(loadPasskeyCredentials(file)[0].counter, 1);
});

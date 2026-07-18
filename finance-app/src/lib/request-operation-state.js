const SNAPSHOT_VERSION = 1;
const RECORD_VERSION = 1;
const REACT_QUERY_MUTATION_RETRY = 0;

const OPERATION_STATES = Object.freeze({
  PREPARED: 'prepared',
  DISPATCHING: 'dispatching',
  OUTCOME_UNKNOWN: 'outcome_unknown',
});

const HASH_RE = /^[a-f0-9]{64}$/;
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const ERROR_CODE_RE = /^[A-Z0-9_:-]{1,64}$/;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f]/;
const TERMINAL_ERROR_STATUS_MIN = 400;
const TERMINAL_ERROR_STATUS_MAX = 499;
const OUTCOME_UNKNOWN_MESSAGE = 'Request outcome is unknown. Check the operation before retrying.';

class RequestOperationError extends Error {
  constructor(message, status, code, extras = {}) {
    super(message);
    this.name = 'RequestOperationError';
    this.error = message;
    this.status = status;
    this.code = code;
    if (extras.requiresIdempotencyKeyReuse === true) {
      this.requiresIdempotencyKeyReuse = true;
    }
  }
}

function operationError(message, status, code, extras = {}) {
  return new RequestOperationError(message, status, code, extras);
}

function outcomeUnknownError() {
  return operationError(OUTCOME_UNKNOWN_MESSAGE, 409, 'OUTCOME_UNKNOWN');
}

function storageError() {
  return operationError(
    'Could not safely update pending finance operation state. No automatic retry was sent.',
    500,
    'LOCAL_OPERATION_STORAGE_ERROR',
  );
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function jsonValue(value) {
  const serialized = JSON.stringify(value === undefined ? null : value);
  if (serialized === undefined) throw new TypeError('Mutation variables must be JSON serializable');
  return JSON.parse(serialized);
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  const sorted = Object.create(null);
  for (const key of Object.keys(value).sort()) sorted[key] = sortJson(value[key]);
  return sorted;
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(jsonValue(value)));
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalQueryPairs(searchParams) {
  return [...searchParams.entries()]
    .map(([key, value], index) => ({ key, value, index }))
    .sort((left, right) => compareStrings(left.key, right.key) || left.index - right.index)
    .map(({ key, value }) => [key, value]);
}

function canonicalEndpoint(endpoint) {
  const url = new URL(String(endpoint || '/'), 'https://request-operation.invalid');
  return {
    pathname: url.pathname || '/',
    query: canonicalQueryPairs(url.searchParams),
  };
}

function assertDigest(value, name) {
  if (!HASH_RE.test(value)) throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
}

function deriveRequestDigest(input, hash) {
  assertDigest(input.scopeDigest, 'scopeDigest');
  const method = String(input.method || '').toUpperCase();
  if (!method) throw new TypeError('Mutation method is required');
  const endpoint = canonicalEndpoint(input.endpoint);
  const identity = [
    'darkfinances-request-operation-v1',
    input.scopeDigest,
    method,
    endpoint.pathname,
    canonicalJson(endpoint.query),
    canonicalJson(input.body),
  ].join('\n');
  const digest = String(hash(identity));
  assertDigest(digest, 'requestDigest');
  return digest;
}

function normalizeTerminalError(value) {
  if (!isObject(value)) return null;
  const status = Number(value.status);
  const code = typeof value.code === 'string' ? value.code : '';
  const message = typeof value.message === 'string' ? value.message : '';
  if (
    !Number.isInteger(status)
    || status < TERMINAL_ERROR_STATUS_MIN
    || status > TERMINAL_ERROR_STATUS_MAX
    || !ERROR_CODE_RE.test(code)
    || !message
    || message.length > 240
    || CONTROL_CHARACTER_RE.test(message)
  ) return null;
  return { status, code, message };
}

function isRetryableAdmissionError(error) {
  if (error?.requiresIdempotencyKeyReuse === true) return true;
  const status = Number(error?.status);
  const code = typeof error?.code === 'string' ? error.code : '';
  if (status === 429 || status === 503) return true;
  if (code === 'ADMISSION_OVERLOADED' || code === 'ADMISSION_UNAVAILABLE') return true;
  return false;
}

function classifyDirectMutationError(error) {
  const status = Number(error?.status);
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.error === 'string'
    ? error.error
    : typeof error?.message === 'string'
      ? error.message
      : 'Operation failed';
  if (isRetryableAdmissionError(error)) {
    return {
      kind: 'retry_same_key',
      error: {
        status: Number.isInteger(status) ? status : 429,
        code: code || 'ADMISSION_OVERLOADED',
        message,
      },
    };
  }
  const terminal = Number.isInteger(status)
    && status >= TERMINAL_ERROR_STATUS_MIN
    && status <= TERMINAL_ERROR_STATUS_MAX
    && status !== 408
    && !!code
    && code !== 'OUTCOME_UNKNOWN'
    && code !== 'OPERATION_NOT_FOUND'
    && code !== 'MALFORMED_RESPONSE';
  return terminal
    ? { kind: 'failed', error: { status, code: code || 'OPERATION_FAILED', message } }
    : { kind: 'outcome_unknown' };
}

function createRedactedReconciliationDiagnostic(error, now = Date.now) {
  const code = typeof error?.code === 'string' && ERROR_CODE_RE.test(error.code)
    ? error.code
    : 'RECONCILIATION_FAILED';
  const candidateStatus = Number(error?.status);
  const status = Number.isInteger(candidateStatus) && candidateStatus >= 100 && candidateStatus <= 599
    ? candidateStatus
    : 0;
  const candidateTimestamp = Number(now());
  const timestamp = Number.isFinite(candidateTimestamp) ? Math.trunc(candidateTimestamp) : 0;
  return { code, status, timestamp };
}

function createReconciliationDiagnosticStore({ read, write }, now = Date.now) {
  if (typeof read !== 'function' || typeof write !== 'function') {
    throw new TypeError('Diagnostic read and write functions are required');
  }
  return {
    record(error) {
      try {
        write(JSON.stringify(createRedactedReconciliationDiagnostic(error, now)));
      } catch {
        // Diagnostics are best effort and must not affect mutation recovery.
      }
    },
    get() {
      try {
        const value = read();
        if (!value) return null;
        const parsed = JSON.parse(value);
        const diagnostic = createRedactedReconciliationDiagnostic(
          parsed,
          () => Number(parsed?.timestamp),
        );
        if (
          diagnostic.code !== parsed?.code
          || diagnostic.status !== parsed?.status
          || diagnostic.timestamp !== parsed?.timestamp
        ) return null;
        return diagnostic;
      } catch {
        return null;
      }
    },
    clear() {
      try {
        write(null);
      } catch {
        // Diagnostic cleanup must not affect profile or mutation state.
      }
    },
  };
}

function validateRecord(record, digest) {
  if (!isObject(record)) return false;
  const allowed = new Set([
    'version',
    'requestDigest',
    'scopeDigest',
    'idempotencyKey',
    'state',
    'createdAt',
    'updatedAt',
    'dispatchStartedAt',
    'outcomeUnknownAt',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return false;
  if (
    record.version !== RECORD_VERSION
    || record.requestDigest !== digest
    || !HASH_RE.test(record.requestDigest)
    || !HASH_RE.test(record.scopeDigest)
    || !KEY_RE.test(record.idempotencyKey)
    || !Object.values(OPERATION_STATES).includes(record.state)
    || !Number.isFinite(record.createdAt)
    || !Number.isFinite(record.updatedAt)
    || record.updatedAt < record.createdAt
  ) return false;
  if (record.state === OPERATION_STATES.PREPARED) {
    return !own(record, 'dispatchStartedAt') && !own(record, 'outcomeUnknownAt');
  }
  if (!Number.isFinite(record.dispatchStartedAt) || record.dispatchStartedAt < record.createdAt) return false;
  if (record.state === OPERATION_STATES.DISPATCHING) return !own(record, 'outcomeUnknownAt');
  return Number.isFinite(record.outcomeUnknownAt)
    && record.outcomeUnknownAt >= record.dispatchStartedAt;
}

function validateSnapshot(value) {
  if (value == null) return { version: SNAPSHOT_VERSION, generation: 0, operations: {} };
  if (
    !isObject(value)
    || value.version !== SNAPSHOT_VERSION
    || !Number.isSafeInteger(value.generation)
    || value.generation < 0
    || !isObject(value.operations)
    || Object.keys(value).some((key) => !['version', 'generation', 'operations'].includes(key))
  ) throw storageError();
  const seenKeys = new Set();
  for (const [digest, record] of Object.entries(value.operations)) {
    if (!validateRecord(record, digest) || seenKeys.has(record.idempotencyKey)) throw storageError();
    seenKeys.add(record.idempotencyKey);
  }
  return clone(value);
}

function createRequestOperationMachine({ store, hash, keyFactory, now = Date.now }) {
  if (!store || typeof store.read !== 'function' || typeof store.write !== 'function') {
    throw new TypeError('A synchronous operation store is required');
  }
  if (typeof hash !== 'function' || typeof keyFactory !== 'function') {
    throw new TypeError('Hash and key factories are required');
  }

  const inFlight = new Map();
  const statusInFlight = new Map();

  function readSnapshot() {
    try {
      return validateSnapshot(store.read());
    } catch (error) {
      if (error instanceof RequestOperationError) throw error;
      throw storageError();
    }
  }

  function writeSnapshot(snapshot) {
    try {
      store.write(clone(snapshot));
    } catch {
      throw storageError();
    }
  }

  function timestampAfter(record) {
    const value = Number(now());
    if (!Number.isFinite(value)) throw new TypeError('Operation clock returned an invalid timestamp');
    return Math.max(value, record?.updatedAt ?? value);
  }

  function identityFor(input) {
    const requestDigest = deriveRequestDigest(input, hash);
    return { requestDigest, scopeDigest: input.scopeDigest };
  }

  function prepareWithIdentity(identity) {
    const snapshot = readSnapshot();
    const existing = snapshot.operations[identity.requestDigest];
    if (existing) return clone(existing);

    const createdAt = timestampAfter();
    if (snapshot.generation === Number.MAX_SAFE_INTEGER) {
      throw operationError(
        'Could not allocate another idempotency key. The mutation was not sent.',
        500,
        'IDEMPOTENCY_KEY_UNAVAILABLE',
      );
    }
    const generation = snapshot.generation + 1;
    let idempotencyKey;
    try {
      idempotencyKey = String(keyFactory({
        requestDigest: identity.requestDigest,
        scopeDigest: identity.scopeDigest,
        createdAt,
        generation,
      }));
    } catch {
      throw operationError(
        'Could not generate a secure idempotency key. The mutation was not sent.',
        500,
        'IDEMPOTENCY_KEY_UNAVAILABLE',
      );
    }
    if (!KEY_RE.test(idempotencyKey)) {
      throw operationError(
        'Could not generate a valid idempotency key. The mutation was not sent.',
        500,
        'IDEMPOTENCY_KEY_UNAVAILABLE',
      );
    }
    if (Object.values(snapshot.operations).some((record) => record.idempotencyKey === idempotencyKey)) {
      throw operationError(
        'The generated idempotency key is already in use. The mutation was not sent.',
        500,
        'IDEMPOTENCY_KEY_COLLISION',
      );
    }

    const record = {
      version: RECORD_VERSION,
      requestDigest: identity.requestDigest,
      scopeDigest: identity.scopeDigest,
      idempotencyKey,
      state: OPERATION_STATES.PREPARED,
      createdAt,
      updatedAt: createdAt,
    };
    snapshot.generation = generation;
    snapshot.operations[identity.requestDigest] = record;
    writeSnapshot(snapshot);
    return clone(record);
  }

  function prepare(input) {
    return prepareWithIdentity(identityFor(input));
  }

  function markDispatching(requestDigest) {
    const snapshot = readSnapshot();
    const record = snapshot.operations[requestDigest];
    if (!record) throw operationError('Pending operation was not found', 500, 'LOCAL_OPERATION_STATE_ERROR');
    if (record.state !== OPERATION_STATES.PREPARED) return clone(record);
    const dispatchStartedAt = timestampAfter(record);
    const next = {
      ...record,
      state: OPERATION_STATES.DISPATCHING,
      updatedAt: dispatchStartedAt,
      dispatchStartedAt,
    };
    snapshot.operations[requestDigest] = next;
    writeSnapshot(snapshot);
    return clone(next);
  }

  function markOutcomeUnknown(requestDigest) {
    const snapshot = readSnapshot();
    const record = snapshot.operations[requestDigest];
    if (!record) return null;
    if (record.state === OPERATION_STATES.PREPARED) {
      throw operationError('Prepared operation has not been dispatched', 500, 'LOCAL_OPERATION_STATE_ERROR');
    }
    const outcomeUnknownAt = timestampAfter(record);
    const next = {
      ...record,
      state: OPERATION_STATES.OUTCOME_UNKNOWN,
      updatedAt: outcomeUnknownAt,
      outcomeUnknownAt,
    };
    snapshot.operations[requestDigest] = next;
    writeSnapshot(snapshot);
    return clone(next);
  }

  function markPrepared(requestDigest) {
    const snapshot = readSnapshot();
    const record = snapshot.operations[requestDigest];
    if (!record) return null;
    const updatedAt = timestampAfter(record);
    const next = {
      version: RECORD_VERSION,
      requestDigest: record.requestDigest,
      scopeDigest: record.scopeDigest,
      idempotencyKey: record.idempotencyKey,
      state: OPERATION_STATES.PREPARED,
      createdAt: record.createdAt,
      updatedAt,
    };
    snapshot.operations[requestDigest] = next;
    writeSnapshot(snapshot);
    return clone(next);
  }

  function clear(requestDigest) {
    const snapshot = readSnapshot();
    if (!snapshot.operations[requestDigest]) return;
    delete snapshot.operations[requestDigest];
    writeSnapshot(snapshot);
  }

  function listRecords(scopeDigest) {
    const snapshot = readSnapshot();
    return Object.values(snapshot.operations)
      .filter((record) => !scopeDigest || record.scopeDigest === scopeDigest)
      .map(clone);
  }

  function queryStatusOnce(record, queryStatus) {
    const existing = statusInFlight.get(record.requestDigest);
    if (existing) return existing;
    const promise = Promise.resolve().then(() => queryStatus(record.idempotencyKey));
    statusInFlight.set(record.requestDigest, promise);
    const remove = () => {
      if (statusInFlight.get(record.requestDigest) === promise) {
        statusInFlight.delete(record.requestDigest);
      }
    };
    void promise.then(remove, remove);
    return promise;
  }

  async function resolveStatus(record, queryStatus) {
    let status;
    try {
      status = await queryStatusOnce(record, queryStatus);
    } catch {
      markOutcomeUnknown(record.requestDigest);
      throw outcomeUnknownError();
    }

    if (isObject(status) && status.status === 'completed' && own(status, 'result')) {
      clear(record.requestDigest);
      return status.result;
    }
    if (isObject(status) && status.status === 'failed') {
      const terminalError = normalizeTerminalError(status.error);
      if (terminalError) {
        clear(record.requestDigest);
        throw operationError(terminalError.message, terminalError.status, terminalError.code);
      }
    }
    markOutcomeUnknown(record.requestDigest);
    throw outcomeUnknownError();
  }

  async function runWithIdentity(input, identity) {
    let record = prepareWithIdentity(identity);
    if (record.state !== OPERATION_STATES.PREPARED) {
      return resolveStatus(record, input.queryStatus);
    }

    record = markDispatching(record.requestDigest);
    let outcome;
    try {
      outcome = await input.dispatch(record.idempotencyKey);
    } catch (error) {
      outcome = classifyDirectMutationError(error);
    }

    if (isObject(outcome) && outcome.kind === 'completed' && own(outcome, 'result')) {
      clear(record.requestDigest);
      return outcome.result;
    }
    if (isObject(outcome) && outcome.kind === 'retry_same_key') {
      markPrepared(record.requestDigest);
      const retryError = normalizeTerminalError(outcome.error) || outcome.error;
      throw operationError(
        retryError.message || 'The server is busy. Retry shortly.',
        retryError.status || 429,
        retryError.code || 'ADMISSION_OVERLOADED',
        { requiresIdempotencyKeyReuse: true },
      );
    }
    if (isObject(outcome) && outcome.kind === 'failed') {
      const terminalError = normalizeTerminalError(outcome.error);
      if (terminalError) {
        clear(record.requestDigest);
        throw operationError(terminalError.message, terminalError.status, terminalError.code);
      }
    }

    record = markOutcomeUnknown(record.requestDigest);
    return resolveStatus(record, input.queryStatus);
  }

  function execute(input) {
    const identity = identityFor(input);
    const existing = inFlight.get(identity.requestDigest);
    if (existing) return existing;
    const promise = runWithIdentity(input, identity);
    inFlight.set(identity.requestDigest, promise);
    const remove = () => {
      if (inFlight.get(identity.requestDigest) === promise) inFlight.delete(identity.requestDigest);
    };
    void promise.then(remove, remove);
    return promise;
  }

  async function reconcileProfile(scopeDigest, queryStatus) {
    assertDigest(scopeDigest, 'scopeDigest');
    const records = listRecords(scopeDigest)
      .filter((record) => record.state !== OPERATION_STATES.PREPARED);
    const summary = { checked: 0, completed: 0, failed: 0, unresolved: 0 };
    for (const record of records) {
      if (inFlight.has(record.requestDigest)) continue;
      summary.checked += 1;
      let status;
      try {
        status = await queryStatusOnce(record, queryStatus);
      } catch {
        markOutcomeUnknown(record.requestDigest);
        summary.unresolved += 1;
        continue;
      }
      if (isObject(status) && status.status === 'completed' && own(status, 'result')) {
        clear(record.requestDigest);
        summary.completed += 1;
        continue;
      }
      if (isObject(status) && status.status === 'failed' && normalizeTerminalError(status.error)) {
        clear(record.requestDigest);
        summary.failed += 1;
        continue;
      }
      markOutcomeUnknown(record.requestDigest);
      summary.unresolved += 1;
    }
    return summary;
  }

  function prepareProfilePurge(scopeDigest) {
    if (scopeDigest) assertDigest(scopeDigest, 'scopeDigest');
    const snapshot = readSnapshot();
    const matching = Object.values(snapshot.operations)
      .filter((record) => !scopeDigest || record.scopeDigest === scopeDigest);
    if (matching.some((record) => record.state !== OPERATION_STATES.PREPARED)) {
      throw operationError(
        'A finance operation may still be running. Reconcile it before changing or deleting this profile.',
        409,
        'UNRESOLVED_OPERATION_PROFILE_LOCK',
      );
    }
    let changed = false;
    for (const record of matching) {
      delete snapshot.operations[record.requestDigest];
      changed = true;
    }
    if (changed) writeSnapshot(snapshot);
  }

  return {
    clear,
    deriveRequestDigest: (input) => deriveRequestDigest(input, hash),
    execute,
    listRecords,
    markDispatching,
    markOutcomeUnknown,
    prepare,
    prepareProfilePurge,
    reconcileProfile,
  };
}

async function executeMutationWithIdempotency({ demo, machine, demoDispatch, operation }) {
  if (demo) return demoDispatch();
  return machine.execute(operation);
}

module.exports = {
  OPERATION_STATES,
  OUTCOME_UNKNOWN_MESSAGE,
  REACT_QUERY_MUTATION_RETRY,
  RequestOperationError,
  canonicalEndpoint,
  canonicalJson,
  classifyDirectMutationError,
  createReconciliationDiagnosticStore,
  createRedactedReconciliationDiagnostic,
  createRequestOperationMachine,
  deriveRequestDigest,
  executeMutationWithIdempotency,
  isRetryableAdmissionError,
};

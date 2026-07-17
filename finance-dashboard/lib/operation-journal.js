const crypto = require('crypto');
const { readJsonFile, writeJsonFile } = require('./json-store');
const { AppError } = require('./errors');
const { sanitizeIssues } = require('./request-issues');
const { statePath } = require('./state-registry');

const OUTER_SCHEMA_VERSION = 1;
const OPERATION_RECORD_VERSION = 2;
const FINGERPRINT_VERSION = 2;
const MAX_TERMINAL_ENTRIES = 1000;
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const PHASES = Object.freeze({
  STARTED: 'started',
  LOCAL_APPLIED: 'local_applied',
  SYNC_UNKNOWN: 'sync_unknown',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

function legacyRequestFingerprint(method, route, body) {
  return crypto
    .createHash('sha256')
    .update(`${method}\n${route}\n${JSON.stringify(body ?? null)}`)
    .digest('hex');
}

function jsonValue(value) {
  const serialized = JSON.stringify(value === undefined ? null : value);
  if (serialized === undefined) throw new TypeError('Value is not JSON serializable');
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

function canonicalPath(value) {
  const raw = String(value || '/');
  const url = new URL(raw, 'http://operation-journal.invalid');
  return url.pathname || '/';
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function queryPairs(value) {
  let params;
  if (value instanceof URLSearchParams) {
    params = new URLSearchParams(value);
  } else if (typeof value === 'string') {
    params = new URLSearchParams(value.replace(/^\?/, '').split('#', 1)[0]);
  } else {
    params = new URLSearchParams();
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        const values = Array.isArray(value[key]) ? value[key] : [value[key]];
        for (const item of values) params.append(key, item == null ? '' : String(item));
      }
    }
  }
  return [...params.entries()]
    .map(([key, item], index) => ({ key, item, index }))
    .sort((left, right) => compareStrings(left.key, right.key) || left.index - right.index)
    .map(({ key, item }) => [key, item]);
}

function normalizedRequest(requestOrMethod, route, body, query) {
  const request = requestOrMethod && typeof requestOrMethod === 'object'
    ? requestOrMethod
    : { method: requestOrMethod, route, body, query };
  const rawUrl = request.url || request.route || request.path || '/';
  const path = canonicalPath(request.path || request.route || rawUrl);
  let queryValue;
  if (Object.prototype.hasOwnProperty.call(request, 'query')) {
    queryValue = request.query;
  } else if (Object.prototype.hasOwnProperty.call(request, 'queryString')) {
    queryValue = request.queryString;
  } else {
    queryValue = new URL(String(rawUrl), 'http://operation-journal.invalid').searchParams;
  }
  return {
    method: String(request.method || '').toUpperCase(),
    path,
    query: queryPairs(queryValue),
    body: request.body === undefined ? null : request.body,
  };
}

function requestFingerprint(requestOrMethod, route, body, query) {
  const request = normalizedRequest(requestOrMethod, route, body, query);
  return crypto
    .createHash('sha256')
    .update(`${request.method}\n${request.path}\n${canonicalJson(request.query)}\n${canonicalJson(request.body)}`)
    .digest('hex');
}

function legacyFingerprintForRequest(request) {
  const route = canonicalPath(request.route || request.path || request.url || '/');
  return legacyRequestFingerprint(String(request.method || ''), route, request.body);
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validIssue(value) {
  return isObject(value)
    && typeof value.path === 'string'
    && value.path.length >= 1
    && value.path.length <= 32
    && typeof value.message === 'string'
    && value.message.length >= 1
    && value.message.length <= 160
    && !/base64|secret|token|password/i.test(value.path)
    && !/base64|secret|token|password/i.test(value.message);
}

function validIssues(value) {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return false;
  return value.every(validIssue);
}

function validError(value) {
  return isObject(value)
    && /^[A-Z0-9_:-]{1,64}$/.test(value.code || '')
    && typeof value.message === 'string'
    && value.message.length >= 1
    && value.message.length <= 240
    && [...value.message].every((character) => {
      const point = character.codePointAt(0);
      return point > 0x1f && (point < 0x7f || point > 0x9f);
    })
    && Number.isInteger(value.status)
    && value.status >= 400
    && value.status <= 599
    && validIssues(value.issues);
}

function validLegacyOperation(key, operation) {
  return operation.recordVersion === undefined
    && operation.phase === undefined
    && operation.fingerprintVersion === undefined
    && (!operation.key || operation.key === key)
    && HASH_RE.test(operation.fingerprint || '')
    && typeof operation.method === 'string'
    && typeof operation.route === 'string'
    && ['started', 'completed', 'failed'].includes(operation.status);
}

function validVersionedOperation(key, operation) {
  if (
    operation.recordVersion !== OPERATION_RECORD_VERSION
    || operation.fingerprintVersion !== FINGERPRINT_VERSION
    || operation.key !== key
    || !HASH_RE.test(operation.fingerprint || '')
    || typeof operation.method !== 'string'
    || typeof operation.route !== 'string'
    || !Object.values(PHASES).includes(operation.phase)
  ) return false;

  const has = (field) => Object.prototype.hasOwnProperty.call(operation, field);
  if (operation.phase === PHASES.STARTED) {
    return operation.status === 'started'
      && !has('provisionalResult')
      && !has('localAppliedAt')
      && !has('syncStartedAt')
      && !has('result')
      && !has('error');
  }
  if (operation.phase === PHASES.LOCAL_APPLIED) {
    return operation.status === 'started'
      && has('provisionalResult')
      && has('localAppliedAt')
      && !has('syncStartedAt')
      && !has('result')
      && !has('error');
  }
  if (operation.phase === PHASES.SYNC_UNKNOWN) {
    return operation.status === 'started'
      && has('provisionalResult')
      && has('localAppliedAt')
      && has('syncStartedAt')
      && !has('result')
      && !has('error');
  }
  if (operation.phase === PHASES.COMPLETED) {
    return operation.status === 'completed'
      && has('result')
      && has('provisionalResult')
      && has('localAppliedAt')
      && !has('error')
      && operation.knownBeforeApply !== true;
  }
  return operation.status === 'failed'
    && operation.knownBeforeApply === true
    && validError(operation.error)
    && !has('provisionalResult')
    && !has('localAppliedAt')
    && !has('syncStartedAt')
    && !has('result');
}

function validState(value) {
  if (
    !value
    || value.schemaVersion !== OUTER_SCHEMA_VERSION
    || !isObject(value.operations)
  ) return false;
  return Object.entries(value.operations).every(([key, operation]) =>
    KEY_RE.test(key)
    && isObject(operation)
    && (validVersionedOperation(key, operation) || validLegacyOperation(key, operation)));
}

function cloneDurable(value) {
  return jsonValue(value);
}

function equivalent(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function transitionError(message, code = 'OPERATION_TRANSITION_INVALID') {
  return new AppError(message, {
    code,
    status: 409,
    expose: true,
  });
}

function sanitizeError(error) {
  const rawCode = String(error?.code || 'OPERATION_FAILED').toUpperCase();
  const code = rawCode.replace(/[^A-Z0-9_:-]/g, '_').slice(0, 64) || 'OPERATION_FAILED';
  const withoutControls = [...String(error?.message || 'Operation failed before local application')]
    .map((character) => {
      const point = character.codePointAt(0);
      return point <= 0x1f || (point >= 0x7f && point <= 0x9f) ? ' ' : character;
    })
    .join('');
  const rawMessage = withoutControls
    .replace(/\s+/g, ' ')
    .trim();
  const message = (rawMessage || 'Operation failed before local application').slice(0, 240);
  const requestedStatus = Number(error?.status);
  const status = Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus <= 599
    ? requestedStatus
    : 400;
  const durable = { code, message, status };
  if (Array.isArray(error?.issues) && error.issues.length) {
    durable.issues = sanitizeIssues(error.issues).slice(0, 8);
  }
  return durable;
}

function isVersioned(operation) {
  return operation?.recordVersion === OPERATION_RECORD_VERSION;
}

function isKnownFailed(operation) {
  return isVersioned(operation)
    && operation.phase === PHASES.FAILED
    && operation.status === 'failed'
    && operation.knownBeforeApply === true;
}

function isCompleted(operation) {
  return operation?.status === 'completed'
    && (!isVersioned(operation) || operation.phase === PHASES.COMPLETED);
}

function isLegacyAmbiguous(operation) {
  return !isVersioned(operation)
    && (operation?.status === 'started' || operation?.status === 'failed');
}

function operationPhase(operation) {
  if (isVersioned(operation)) return operation.phase;
  if (isCompleted(operation)) return PHASES.COMPLETED;
  return PHASES.STARTED;
}

function isTerminal(operation) {
  return isCompleted(operation) || isKnownFailed(operation);
}

function terminalTime(operation) {
  const parsed = Date.parse(operation.completedAt || operation.updatedAt || operation.startedAt || '');
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function ownOperation(operations, key) {
  return Object.prototype.hasOwnProperty.call(operations, key) ? operations[key] : null;
}

function setOperation(operations, key, operation) {
  Object.defineProperty(operations, key, {
    value: operation,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

class OperationJournal {
  constructor(file = statePath('operationJournal'), {
    readState = readJsonFile,
    writeState = writeJsonFile,
    now = () => new Date().toISOString(),
  } = {}) {
    this.file = file;
    this.readState = readState;
    this.writeState = writeState;
    this.now = now;
  }

  read() {
    const { readRuntimeState, registryNameForPath } = require('./runtime-state-store');
    if (registryNameForPath(this.file) === 'operationJournal') {
      return readRuntimeState('operationJournal', { file: this.file }).value;
    }
    return this.readState(
      this.file,
      { schemaVersion: OUTER_SCHEMA_VERSION, operations: {} },
      validState,
    );
  }

  get(key) {
    if (!KEY_RE.test(key || '')) return null;
    return ownOperation(this.read().operations, key);
  }

  start(key, request) {
    if (!KEY_RE.test(key || '')) {
      throw new AppError('A valid Idempotency-Key header is required', {
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        status: 400,
        expose: true,
      });
    }
    const state = this.read();
    const existing = ownOperation(state.operations, key);
    if (existing) {
      const fingerprint = existing.fingerprintVersion === FINGERPRINT_VERSION
        ? requestFingerprint(request)
        : legacyFingerprintForRequest(request);
      if (existing.fingerprint !== fingerprint) {
        throw new AppError('Idempotency key was already used for a different request', {
          code: 'IDEMPOTENCY_KEY_REUSED',
          status: 409,
          expose: true,
        });
      }
      return {
        existing,
        fingerprint: existing.fingerprint,
        fingerprintVersion: existing.fingerprintVersion,
        method: existing.method,
        route: existing.route,
      };
    }
    const normalized = normalizedRequest(request);
    const fingerprint = requestFingerprint(request);
    const now = this.now();
    setOperation(state.operations, key, {
      key,
      recordVersion: OPERATION_RECORD_VERSION,
      fingerprint,
      fingerprintVersion: FINGERPRINT_VERSION,
      method: normalized.method,
      route: normalized.path,
      status: 'started',
      phase: PHASES.STARTED,
      startedAt: now,
      updatedAt: now,
    });
    this.writePruned(state);
    return {
      existing: null,
      fingerprint,
      fingerprintVersion: FINGERPRINT_VERSION,
      method: normalized.method,
      route: normalized.path,
    };
  }

  localApplied(key, provisionalResult) {
    const state = this.read();
    const operation = this.requireVersioned(state, key);
    const durableResult = cloneDurable(provisionalResult === undefined ? null : provisionalResult);
    if (operation.phase === PHASES.LOCAL_APPLIED) {
      if (equivalent(operation.provisionalResult, durableResult)) return operation;
      throw transitionError(
        `Operation ${key} already has a different provisional result`,
        'OPERATION_TRANSITION_CONFLICT',
      );
    }
    if (operation.phase !== PHASES.STARTED) {
      throw transitionError(`Operation ${key} cannot transition from ${operation.phase} to local_applied`);
    }
    state.operations[key] = {
      ...operation,
      status: 'started',
      phase: PHASES.LOCAL_APPLIED,
      provisionalResult: durableResult,
      localAppliedAt: this.now(),
      updatedAt: this.now(),
    };
    this.writePruned(state);
    return state.operations[key];
  }

  syncUnknown(key) {
    const state = this.read();
    const operation = this.requireVersioned(state, key);
    if (operation.phase === PHASES.SYNC_UNKNOWN) return operation;
    if (operation.phase !== PHASES.LOCAL_APPLIED) {
      throw transitionError(`Operation ${key} cannot transition from ${operation.phase} to sync_unknown`);
    }
    state.operations[key] = {
      ...operation,
      status: 'started',
      phase: PHASES.SYNC_UNKNOWN,
      syncStartedAt: this.now(),
      updatedAt: this.now(),
    };
    this.writePruned(state);
    return state.operations[key];
  }

  complete(key, result) {
    const state = this.read();
    const operation = this.requireVersioned(state, key);
    const durableResult = cloneDurable(result === undefined ? null : result);
    if (operation.phase === PHASES.COMPLETED) {
      if (equivalent(operation.result, durableResult)) return operation;
      throw transitionError(
        `Operation ${key} already completed with a different result`,
        'OPERATION_TRANSITION_CONFLICT',
      );
    }
    if (![PHASES.LOCAL_APPLIED, PHASES.SYNC_UNKNOWN].includes(operation.phase)) {
      throw transitionError(`Operation ${key} cannot transition from ${operation.phase} to completed`);
    }
    const now = this.now();
    state.operations[key] = {
      ...operation,
      status: 'completed',
      phase: PHASES.COMPLETED,
      completedAt: now,
      updatedAt: now,
      result: durableResult,
    };
    this.writePruned(state);
    return state.operations[key];
  }

  reconcileFromTerminalProof(key, proof) {
    const state = this.read();
    const operation = this.requireVersioned(state, key);
    if (!proof || proof.result === undefined) {
      throw transitionError(`Operation ${key} requires terminal proof with a result`);
    }
    if (!proof.fingerprint || proof.fingerprint !== operation.fingerprint) {
      throw transitionError(
        `Operation ${key} terminal proof fingerprint does not match the journal record`,
        'OPERATION_RECONCILE_PROOF_INVALID',
      );
    }
    if (proof.fingerprintVersion !== operation.fingerprintVersion) {
      throw transitionError(
        `Operation ${key} terminal proof fingerprint version does not match the journal record`,
        'OPERATION_RECONCILE_PROOF_INVALID',
      );
    }
    const durableResult = cloneDurable(proof.result);
    if (isCompleted(operation)) {
      if (equivalent(operation.result, durableResult)) return operation;
      throw transitionError(
        `Operation ${key} already completed with a different result`,
        'OPERATION_TRANSITION_CONFLICT',
      );
    }
    if (isKnownFailed(operation)) {
      throw transitionError(`Operation ${key} cannot reconcile from terminal proof while failed`);
    }
    if (![PHASES.STARTED, PHASES.LOCAL_APPLIED, PHASES.SYNC_UNKNOWN].includes(operation.phase)) {
      throw transitionError(`Operation ${key} cannot reconcile from ${operation.phase}`);
    }
    const now = this.now();
    state.operations[key] = {
      ...operation,
      status: 'completed',
      phase: PHASES.COMPLETED,
      completedAt: now,
      updatedAt: now,
      result: durableResult,
      provisionalResult: Object.prototype.hasOwnProperty.call(operation, 'provisionalResult')
        ? operation.provisionalResult
        : durableResult,
      localAppliedAt: operation.localAppliedAt || now,
    };
    this.writePruned(state);
    return state.operations[key];
  }

  failBeforeApply(key, error) {
    const state = this.read();
    const operation = this.requireVersioned(state, key);
    const durableError = sanitizeError(error);
    if (operation.phase === PHASES.FAILED) {
      if (equivalent(operation.error, durableError)) return operation;
      throw transitionError(
        `Operation ${key} already failed with a different error`,
        'OPERATION_TRANSITION_CONFLICT',
      );
    }
    if (operation.phase !== PHASES.STARTED) {
      throw transitionError(`Operation ${key} cannot transition from ${operation.phase} to failed`);
    }
    const now = this.now();
    state.operations[key] = {
      ...operation,
      status: 'failed',
      phase: PHASES.FAILED,
      knownBeforeApply: true,
      completedAt: now,
      updatedAt: now,
      error: durableError,
    };
    this.writePruned(state);
    return state.operations[key];
  }

  fail(key, error) {
    return this.failBeforeApply(key, error);
  }

  status(key) {
    const operation = this.get(key);
    if (!operation) return null;
    const phase = operationPhase(operation);
    const knownFailure = isKnownFailed(operation);
    const completed = isCompleted(operation);
    const value = {
      key,
      status: completed ? 'completed' : knownFailure ? 'failed' : 'started',
      phase,
      terminal: completed || knownFailure,
      outcome: completed ? 'completed' : knownFailure ? 'failed' : 'unknown',
      startedAt: operation.startedAt || null,
      updatedAt: operation.updatedAt || operation.completedAt || operation.startedAt || null,
      completedAt: operation.completedAt || null,
    };
    if (completed) value.result = cloneDurable(operation.result === undefined ? null : operation.result);
    if (knownFailure) value.error = cloneDurable(operation.error);
    if (
      [PHASES.LOCAL_APPLIED, PHASES.SYNC_UNKNOWN].includes(phase)
      && Object.prototype.hasOwnProperty.call(operation, 'provisionalResult')
    ) value.provisionalResult = cloneDurable(operation.provisionalResult);
    if (isLegacyAmbiguous(operation)) {
      value.legacyAmbiguous = true;
      value.legacyStatus = operation.status;
    }
    return value;
  }

  requireVersioned(state, key) {
    const operation = ownOperation(state.operations, key);
    if (!operation) throw transitionError(`Operation ${key} was not started`);
    if (!isVersioned(operation)) {
      throw transitionError(`Legacy operation ${key} is outcome-unknown and cannot transition`);
    }
    return operation;
  }

  writePruned(state) {
    const terminal = Object.entries(state.operations).filter(([, operation]) => isTerminal(operation));
    if (terminal.length > MAX_TERMINAL_ENTRIES) {
      terminal
        .sort(([aKey, a], [bKey, b]) => terminalTime(a) - terminalTime(b) || compareStrings(aKey, bKey))
        .slice(0, terminal.length - MAX_TERMINAL_ENTRIES)
        .forEach(([key]) => delete state.operations[key]);
    }
    const { writeRuntimeState, registryNameForPath } = require('./runtime-state-store');
    if (registryNameForPath(this.file) === 'operationJournal') {
      writeRuntimeState('operationJournal', state, { file: this.file });
      return;
    }
    this.writeState(this.file, state);
  }
}

module.exports = {
  FINGERPRINT_VERSION,
  MAX_TERMINAL_ENTRIES,
  OPERATION_RECORD_VERSION,
  OperationJournal,
  PHASES,
  canonicalJson,
  canonicalPath,
  isCompleted,
  isKnownFailed,
  isLegacyAmbiguous,
  legacyRequestFingerprint,
  operationPhase,
  queryPairs,
  requestFingerprint,
  sanitizeError,
  validState,
};

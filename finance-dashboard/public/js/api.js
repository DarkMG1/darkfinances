import { setFinanceTimeZone } from './finance-date.js';

export const BROWSER_OPERATION_STORAGE_KEY = 'darkfinances.browser-operations.v1';

const SNAPSHOT_VERSION = 1;
const RECORD_VERSION = 1;
const HASH_RE = /^[a-f0-9]{64}$/;
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const ERROR_CODE_RE = /^[A-Z0-9_:-]{1,64}$/;
const OPERATION_STATES = Object.freeze({
  PREPARED: 'prepared',
  DISPATCHING: 'dispatching',
  OUTCOME_UNKNOWN: 'outcome_unknown',
});
const OUTCOME_UNKNOWN_MESSAGE = 'Request outcome is unknown. Check the operation before retrying.';
const inFlight = new Map();

export class FinanceMutationError extends Error {
  constructor(message, status, code, extras = {}) {
    super(message);
    this.name = 'FinanceMutationError';
    this.error = message;
    this.status = status;
    this.code = code;
    if (Array.isArray(extras.issues)) this.issues = extras.issues;
    if (extras.requiresIdempotencyKeyReuse === true) this.requiresIdempotencyKeyReuse = true;
  }
}

function mutationError(message, status, code, extras) {
  return new FinanceMutationError(message, status, code, extras);
}

function outcomeUnknownError() {
  return mutationError(OUTCOME_UNKNOWN_MESSAGE, 409, 'OUTCOME_UNKNOWN', {
    requiresIdempotencyKeyReuse: true,
  });
}

function storageError() {
  return mutationError(
    'Could not safely update pending finance operation state. The mutation was not sent again.',
    500,
    'LOCAL_OPERATION_STORAGE_ERROR',
  );
}

function cryptoError() {
  return mutationError(
    'Could not create a secure finance operation identity. The mutation was not sent.',
    500,
    'LOCAL_OPERATION_CRYPTO_ERROR',
  );
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function emptySnapshot() {
  return { version: SNAPSHOT_VERSION, operations: {} };
}

function validRecord(fingerprint, record) {
  if (!isObject(record)) return false;
  const allowed = new Set([
    'version',
    'fingerprint',
    'key',
    'state',
    'createdAt',
    'updatedAt',
    'dispatchStartedAt',
    'outcomeUnknownAt',
  ]);
  if (
    Object.keys(record).some((key) => !allowed.has(key))
    || record.version !== RECORD_VERSION
    || record.fingerprint !== fingerprint
    || !HASH_RE.test(record.fingerprint)
    || !KEY_RE.test(record.key)
    || !Object.values(OPERATION_STATES).includes(record.state)
    || !Number.isFinite(record.createdAt)
    || !Number.isFinite(record.updatedAt)
    || record.updatedAt < record.createdAt
  ) return false;
  if (record.state === OPERATION_STATES.PREPARED) {
    return !own(record, 'dispatchStartedAt') && !own(record, 'outcomeUnknownAt');
  }
  if (!Number.isFinite(record.dispatchStartedAt) || record.dispatchStartedAt < record.createdAt) {
    return false;
  }
  if (record.state === OPERATION_STATES.DISPATCHING) return !own(record, 'outcomeUnknownAt');
  return Number.isFinite(record.outcomeUnknownAt)
    && record.outcomeUnknownAt >= record.dispatchStartedAt;
}

function readSnapshot() {
  let raw;
  try {
    raw = globalThis.localStorage.getItem(BROWSER_OPERATION_STORAGE_KEY);
  } catch {
    throw storageError();
  }
  if (!raw) return emptySnapshot();
  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch {
    throw storageError();
  }
  if (
    !isObject(snapshot)
    || snapshot.version !== SNAPSHOT_VERSION
    || !isObject(snapshot.operations)
    || Object.keys(snapshot).some((key) => !['version', 'operations'].includes(key))
  ) throw storageError();
  const operationKeys = new Set();
  for (const [fingerprint, record] of Object.entries(snapshot.operations)) {
    if (!validRecord(fingerprint, record) || operationKeys.has(record.key)) throw storageError();
    operationKeys.add(record.key);
  }
  return snapshot;
}

function writeSnapshot(snapshot) {
  try {
    globalThis.localStorage.setItem(BROWSER_OPERATION_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    throw storageError();
  }
}

function timestampAfter(record) {
  const timestamp = Date.now();
  if (!Number.isFinite(timestamp)) throw storageError();
  return Math.max(timestamp, record?.updatedAt ?? timestamp);
}

function prepareOperation(fingerprint) {
  const snapshot = readSnapshot();
  if (snapshot.operations[fingerprint]) return snapshot.operations[fingerprint];
  let key;
  try {
    key = globalThis.crypto.randomUUID();
  } catch {
    throw cryptoError();
  }
  if (!KEY_RE.test(key) || Object.values(snapshot.operations).some((record) => record.key === key)) {
    throw cryptoError();
  }
  const createdAt = timestampAfter();
  const record = {
    version: RECORD_VERSION,
    fingerprint,
    key,
    state: OPERATION_STATES.PREPARED,
    createdAt,
    updatedAt: createdAt,
  };
  snapshot.operations[fingerprint] = record;
  writeSnapshot(snapshot);
  return record;
}

function replaceOperation(fingerprint, transition) {
  const snapshot = readSnapshot();
  const current = snapshot.operations[fingerprint];
  if (!current) throw storageError();
  const next = transition(current);
  if (!validRecord(fingerprint, next)) throw storageError();
  snapshot.operations[fingerprint] = next;
  writeSnapshot(snapshot);
  return next;
}

function markDispatching(fingerprint) {
  return replaceOperation(fingerprint, (record) => {
    if (record.state !== OPERATION_STATES.PREPARED) return record;
    const dispatchStartedAt = timestampAfter(record);
    return {
      ...record,
      state: OPERATION_STATES.DISPATCHING,
      updatedAt: dispatchStartedAt,
      dispatchStartedAt,
    };
  });
}

function markPrepared(fingerprint) {
  return replaceOperation(fingerprint, (record) => ({
    version: RECORD_VERSION,
    fingerprint: record.fingerprint,
    key: record.key,
    state: OPERATION_STATES.PREPARED,
    createdAt: record.createdAt,
    updatedAt: timestampAfter(record),
  }));
}

function markOutcomeUnknown(fingerprint) {
  return replaceOperation(fingerprint, (record) => {
    if (record.state === OPERATION_STATES.PREPARED) throw storageError();
    const updatedAt = timestampAfter(record);
    return {
      ...record,
      state: OPERATION_STATES.OUTCOME_UNKNOWN,
      updatedAt,
      outcomeUnknownAt: record.outcomeUnknownAt ?? updatedAt,
    };
  });
}

function clearOperation(fingerprint) {
  const snapshot = readSnapshot();
  if (!snapshot.operations[fingerprint]) return;
  delete snapshot.operations[fingerprint];
  writeSnapshot(snapshot);
}

function jsonValue(value) {
  const serialized = JSON.stringify(value === undefined ? null : value);
  if (serialized === undefined) throw new TypeError('Mutation body must be JSON serializable');
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

async function requestFingerprint(path, method, body) {
  const endpoint = new URL(`/api/v1${String(path)}`, 'https://browser-operation.invalid');
  const query = [...endpoint.searchParams.entries()]
    .map(([key, value], index) => ({ key, value, index }))
    .sort((left, right) => compareStrings(left.key, right.key) || left.index - right.index)
    .map(({ key, value }) => [key, value]);
  const identity = [
    'darkfinances-browser-operation-v1',
    method,
    endpoint.pathname,
    canonicalJson(query),
    canonicalJson(body),
  ].join('\n');
  let digest;
  try {
    digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(identity),
    );
  } catch {
    throw cryptoError();
  }
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function readJson(response) {
  try {
    const source = typeof response?.clone === 'function' ? response.clone() : response;
    return { valid: true, payload: await source.json() };
  } catch {
    return { valid: false, payload: null };
  }
}

function responseOk(response) {
  if (typeof response?.ok === 'boolean') return response.ok;
  const status = Number(response?.status);
  return Number.isInteger(status) && status >= 200 && status < 300;
}

function responseStatus(response) {
  const status = Number(response?.status);
  if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  return responseOk(response) ? 200 : 0;
}

function validSuccessEnvelope(payload, key) {
  if (!isObject(payload) || !own(payload, 'data')) return false;
  if (!own(payload, 'operation')) return true;
  return isObject(payload.operation)
    && (!own(payload.operation, 'key') || payload.operation.key === key);
}

function normalizeDirectError(response, payload) {
  const status = responseStatus(response);
  if (
    !isObject(payload)
    || typeof payload.error !== 'string'
    || payload.error.length === 0
    || !ERROR_CODE_RE.test(payload.code || '')
    || status < 400
    || status > 599
  ) return null;
  return {
    status,
    code: payload.code,
    message: payload.error,
    issues: Array.isArray(payload.issues) ? payload.issues : undefined,
    requiresIdempotencyKeyReuse: payload.requiresIdempotencyKeyReuse === true
      || payload.admission?.requiresIdempotencyKeyReuse === true,
  };
}

function normalizeStatusError(value) {
  if (
    !isObject(value)
    || !Number.isInteger(value.status)
    || value.status < 400
    || value.status > 599
    || !ERROR_CODE_RE.test(value.code || '')
    || typeof value.message !== 'string'
    || value.message.length === 0
  ) return null;
  return {
    status: value.status,
    code: value.code,
    message: value.message,
    issues: Array.isArray(value.issues) ? value.issues : undefined,
  };
}

function isRetryableAdmissionError(error) {
  return error?.requiresIdempotencyKeyReuse === true
    || error?.status === 429
    || error?.status === 503
    || error?.code === 'ADMISSION_OVERLOADED'
    || error?.code === 'ADMISSION_UNAVAILABLE';
}

function isTerminalDirectError(error) {
  return error.status >= 400
    && error.status <= 499
    && error.status !== 408
    && error.status !== 429
    && error.code !== 'OUTCOME_UNKNOWN'
    && error.code !== 'OPERATION_NOT_FOUND';
}

function errorFrom(value) {
  return mutationError(value.message, value.status, value.code, {
    issues: value.issues,
    requiresIdempotencyKeyReuse: value.requiresIdempotencyKeyReuse,
  });
}

function recoveredResponse(response, operation) {
  const payload = {
    data: operation.result,
    operation: {
      key: operation.key,
      replayed: true,
      recovered: true,
    },
  };
  return {
    ok: true,
    status: 200,
    headers: response?.headers,
    json: async () => payload,
  };
}

async function resolveOperationStatus(record) {
  let response;
  try {
    response = await fetch(`/api/v1/operations/${encodeURIComponent(record.key)}`);
  } catch {
    markOutcomeUnknown(record.fingerprint);
    throw outcomeUnknownError();
  }
  const parsed = await readJson(response);
  const operation = parsed.valid && responseOk(response) && isObject(parsed.payload)
    ? parsed.payload.data
    : null;
  if (
    isObject(operation)
    && (!own(operation, 'key') || operation.key === record.key)
    && operation.status === 'completed'
    && own(operation, 'result')
  ) {
    clearOperation(record.fingerprint);
    return recoveredResponse(response, { ...operation, key: record.key });
  }
  if (
    isObject(operation)
    && (!own(operation, 'key') || operation.key === record.key)
    && operation.status === 'failed'
  ) {
    const terminalError = normalizeStatusError(operation.error);
    if (terminalError) {
      clearOperation(record.fingerprint);
      throw errorFrom(terminalError);
    }
  }
  markOutcomeUnknown(record.fingerprint);
  throw outcomeUnknownError();
}

async function executeMutation(path, method, serializedBody, fingerprint) {
  let record = prepareOperation(fingerprint);
  if (record.state !== OPERATION_STATES.PREPARED) return resolveOperationStatus(record);
  record = markDispatching(fingerprint);

  let response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      headers: {
        'Idempotency-Key': record.key,
        ...(serializedBody === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(serializedBody === undefined ? {} : { body: serializedBody }),
    });
  } catch {
    record = markOutcomeUnknown(fingerprint);
    return resolveOperationStatus(record);
  }

  const parsed = await readJson(response);
  if (responseOk(response) && parsed.valid && validSuccessEnvelope(parsed.payload, record.key)) {
    clearOperation(fingerprint);
    return response;
  }

  const directError = parsed.valid ? normalizeDirectError(response, parsed.payload) : null;
  if (directError && isRetryableAdmissionError(directError)) {
    markPrepared(fingerprint);
    throw errorFrom({ ...directError, requiresIdempotencyKeyReuse: true });
  }
  if (directError && isTerminalDirectError(directError)) {
    clearOperation(fingerprint);
    throw errorFrom(directError);
  }
  record = markOutcomeUnknown(fingerprint);
  return resolveOperationStatus(record);
}

export async function mutateFinance(path, { method = 'POST', body } = {}) {
  const normalizedMethod = String(method || '').toUpperCase();
  if (!normalizedMethod) throw new TypeError('Mutation method is required');
  const serializedBody = body === undefined ? undefined : JSON.stringify(body);
  if (body !== undefined && serializedBody === undefined) {
    throw new TypeError('Mutation body must be JSON serializable');
  }
  const canonicalBody = serializedBody === undefined ? null : JSON.parse(serializedBody);
  const fingerprint = await requestFingerprint(path, normalizedMethod, canonicalBody);
  const existing = inFlight.get(fingerprint);
  if (existing) return existing;
  const promise = executeMutation(path, normalizedMethod, serializedBody, fingerprint);
  inFlight.set(fingerprint, promise);
  const remove = () => {
    if (inFlight.get(fingerprint) === promise) inFlight.delete(fingerprint);
  };
  void promise.then(remove, remove);
  return promise;
}

export async function loadFinanceContext() {
  const response = await fetch('/api/v1/ping');
  if (!response.ok) return;
  const payload = await response.json();
  const data = payload && payload.data;
  if (data && typeof data.financeTimeZone === 'string') setFinanceTimeZone(data.financeTimeZone);
}

export async function loadSection(load, targetIds) {
  try {
    await load();
  } catch (error) {
    console.error(error);
    for (const id of targetIds) {
      const target = document.getElementById(id);
      if (target) target.innerHTML = '<div class="empty-state">Could not load this section. Refresh to retry.</div>';
    }
  }
}

export async function refreshData() {
  await mutateFinance('/refresh');
  location.reload();
}

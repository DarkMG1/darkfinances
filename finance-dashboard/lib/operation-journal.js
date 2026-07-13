const crypto = require('crypto');
const { readJsonFile, writeJsonFile } = require('./json-store');
const { AppError } = require('./errors');
const { statePath } = require('./state-registry');

const MAX_ENTRIES = 1000;
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

function requestFingerprint(method, route, body) {
  return crypto
    .createHash('sha256')
    .update(`${method}\n${route}\n${JSON.stringify(body ?? null)}`)
    .digest('hex');
}

function validState(value) {
  return !!value
    && value.schemaVersion === 1
    && value.operations
    && typeof value.operations === 'object'
    && !Array.isArray(value.operations);
}

class OperationJournal {
  constructor(file = statePath('operationJournal')) {
    this.file = file;
  }

  read() {
    return readJsonFile(this.file, { schemaVersion: 1, operations: {} }, validState);
  }

  get(key) {
    if (!KEY_RE.test(key || '')) return null;
    return this.read().operations[key] || null;
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
    const fingerprint = requestFingerprint(request.method, request.route, request.body);
    const existing = state.operations[key];
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new AppError('Idempotency key was already used for a different request', {
          code: 'IDEMPOTENCY_KEY_REUSED',
          status: 409,
          expose: true,
        });
      }
      return { existing, fingerprint };
    }
    state.operations[key] = {
      key,
      fingerprint,
      method: request.method,
      route: request.route,
      status: 'started',
      startedAt: new Date().toISOString(),
    };
    this.writePruned(state);
    return { existing: null, fingerprint };
  }

  complete(key, result) {
    const state = this.read();
    const operation = state.operations[key];
    if (!operation) throw new Error(`Operation ${key} was not started`);
    state.operations[key] = {
      ...operation,
      status: 'completed',
      completedAt: new Date().toISOString(),
      result: result === undefined ? null : result,
    };
    this.writePruned(state);
  }

  fail(key, error) {
    const state = this.read();
    const operation = state.operations[key];
    if (!operation) return;
    state.operations[key] = {
      ...operation,
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: {
        code: error?.code || 'OPERATION_FAILED',
        message: error?.message || 'Operation failed',
      },
    };
    this.writePruned(state);
  }

  writePruned(state) {
    const entries = Object.entries(state.operations);
    if (entries.length > MAX_ENTRIES) {
      entries
        .sort((a, b) => String(b[1].completedAt || b[1].startedAt).localeCompare(String(a[1].completedAt || a[1].startedAt)))
        .slice(MAX_ENTRIES)
        .forEach(([key]) => delete state.operations[key]);
    }
    writeJsonFile(this.file, state);
  }
}

module.exports = {
  OperationJournal,
  requestFingerprint,
};

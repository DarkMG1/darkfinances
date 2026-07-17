const { JsonStoreError } = require('./json-store');

class AppError extends Error {
  constructor(message, { code = 'APP_ERROR', status = 500, expose = status < 500, cause } = {}) {
    super(message, { cause });
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.expose = expose;
  }
}

// Explicit marker for deterministic failures known to have happened before any
// operation effect. The journal must never infer this property from HTTP status,
// AppError membership, or an error message.
class KnownPreApplyError extends AppError {
  constructor(message, { code = 'KNOWN_PRE_APPLY_FAILURE', status = 400, cause } = {}) {
    super(message, { code, status, expose: true, cause });
    this.name = 'KnownPreApplyError';
  }
}

class RequestValidationError extends KnownPreApplyError {
  constructor(message, issues = []) {
    super(message, { code: 'INVALID_REQUEST', status: 400 });
    this.name = 'RequestValidationError';
    this.issues = issues;
  }
}

class AccountNotFoundError extends AppError {
  constructor() {
    super('account not found', {
      code: 'NOT_FOUND',
      status: 404,
      expose: true,
    });
    this.name = 'AccountNotFoundError';
  }
}

class TransactionNotFoundError extends AppError {
  constructor() {
    super('Transaction not found', {
      code: 'NOT_FOUND',
      status: 404,
      expose: true,
    });
    this.name = 'TransactionNotFoundError';
  }
}

function classifyError(error) {
  if (error instanceof AppError) return error;
  if (error instanceof JsonStoreError) {
    const corrupt = error.code === 'JSON_CORRUPT' || error.code === 'JSON_INVALID_SHAPE';
    return new AppError(
      corrupt
        ? 'Stored finance metadata is corrupt; the original was preserved for recovery'
        : 'Stored finance metadata is temporarily unavailable',
      { code: error.code, status: 500, expose: true, cause: error }
    );
  }
  if (error?.name === 'RuntimeStateError' || String(error?.code || '').startsWith('RUNTIME_STATE_')) {
    return new AppError(error.message, {
      code: error.code || 'RUNTIME_STATE_ERROR',
      status: 500,
      expose: true,
      cause: error,
    });
  }

  const message = String(error?.message || error || 'Unexpected error');
  if (/not found/i.test(message)) {
    return new AppError(message, { code: 'NOT_FOUND', status: 404, expose: true, cause: error });
  }
  if (/bank-imported transactions can[’']?t be deleted/i.test(message)) {
    return new AppError(message, { code: 'IMPORTED_TRANSACTION', status: 409, expose: true, cause: error });
  }
  if (/splitwise snapshot/i.test(message)) {
    return new AppError(message, { code: 'STALE_UPSTREAM_DATA', status: 503, expose: true, cause: error });
  }
  if (/too large|payload too large|exceeds the maximum (encoded|decoded)? receipt size/i.test(message)) {
    return new AppError(message, { code: 'PAYLOAD_TOO_LARGE', status: 413, expose: true, cause: error });
  }
  if (
    /\brequired\b|must be|must sum|invalid|unsupported|unsafe|at least|non-zero|greater than|bad debtor pattern|cannot|can't|can’t/i.test(message)
  ) {
    return new AppError(message, { code: 'INVALID_REQUEST', status: 400, expose: true, cause: error });
  }
  return new AppError('Internal finance service error', {
    code: 'INTERNAL_ERROR',
    status: 500,
    expose: true,
    cause: error,
  });
}

module.exports = {
  AccountNotFoundError,
  AppError,
  KnownPreApplyError,
  RequestValidationError,
  TransactionNotFoundError,
  classifyError,
};

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

class RequestValidationError extends AppError {
  constructor(message, issues = []) {
    super(message, { code: 'INVALID_REQUEST', status: 400, expose: true });
    this.name = 'RequestValidationError';
    this.issues = issues;
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
  AppError,
  RequestValidationError,
  classifyError,
};

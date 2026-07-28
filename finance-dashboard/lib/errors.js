const { JsonStoreError } = require('./json-store');

const GENERIC_INTERNAL_MESSAGE = 'Internal finance service error';
const GENERIC_INTERNAL_CODE = 'INTERNAL_ERROR';

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

class ImportedTransactionError extends AppError {
  constructor() {
    super('Bank-imported transactions can\u2019t be deleted \u2014 only ones you added manually.', {
      code: 'IMPORTED_TRANSACTION',
      status: 409,
      expose: true,
    });
    this.name = 'ImportedTransactionError';
  }
}

function admissionOverloadRequiresKeyReuse({ lane, source, trafficClass } = {}) {
  if (source === 'queue') return true;
  if (lane === 'mutation') return true;
  if (trafficClass === 'recovery') return true;
  return false;
}

class AdmissionOverloadedError extends AppError {
  constructor(message, {
    retryAfterSeconds = 1,
    requiresIdempotencyKeyReuse,
    lane,
    source = 'admission',
    endpoint,
    trafficClass,
  } = {}) {
    super(message, {
      code: 'ADMISSION_OVERLOADED',
      status: 429,
      expose: true,
    });
    this.name = 'AdmissionOverloadedError';
    this.retryAfterSeconds = retryAfterSeconds;
    this.lane = lane ?? undefined;
    this.source = source;
    this.endpoint = endpoint ?? undefined;
    this.trafficClass = trafficClass ?? undefined;
    this.requiresIdempotencyKeyReuse = requiresIdempotencyKeyReuse
      ?? admissionOverloadRequiresKeyReuse({ lane, source, trafficClass });
  }
}

class AdmissionUnavailableError extends AppError {
  constructor(message = 'Request admission is unavailable', {
    lane,
    endpoint,
    trafficClass,
  } = {}) {
    super(message, {
      code: 'ADMISSION_UNAVAILABLE',
      status: 503,
      expose: true,
    });
    this.name = 'AdmissionUnavailableError';
    this.lane = lane ?? undefined;
    this.endpoint = endpoint ?? undefined;
    this.trafficClass = trafficClass ?? undefined;
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

class SplitLegDeleteError extends AppError {
  constructor() {
    super('Split legs cannot be deleted independently', {
      code: 'INVALID_REQUEST',
      status: 400,
      expose: true,
    });
    this.name = 'SplitLegDeleteError';
  }
}

class SplitParentNotFoundError extends AppError {
  constructor() {
    super('Split parent not found', {
      code: 'NOT_FOUND',
      status: 404,
      expose: true,
    });
    this.name = 'SplitParentNotFoundError';
  }
}

class QueryRangeExceededError extends AppError {
  constructor(message = 'Requested ledger window exceeds supported bounds') {
    super(message, {
      code: 'QUERY_RANGE_EXCEEDED',
      status: 400,
      expose: true,
    });
    this.name = 'QueryRangeExceededError';
  }
}

class QueryResultLimitExceededError extends AppError {
  constructor(message = 'Requested ledger result exceeds supported bounds') {
    super(message, {
      code: 'QUERY_RESULT_LIMIT_EXCEEDED',
      status: 413,
      expose: true,
    });
    this.name = 'QueryResultLimitExceededError';
  }
}

class QueryCursorSecretError extends AppError {
  constructor(message = 'Query cursor signing secret is not configured') {
    super(message, {
      code: 'QUERY_CURSOR_SECRET_UNAVAILABLE',
      status: 500,
      expose: false,
    });
    this.name = 'QueryCursorSecretError';
  }
}

class QueryAbortedError extends AppError {
  constructor(message = 'Ledger query was aborted') {
    super(message, {
      code: 'QUERY_ABORTED',
      status: 503,
      expose: true,
    });
    this.name = 'QueryAbortedError';
    this.requiresIdempotencyKeyReuse = false;
  }
}

function isQueryAbortedError(error) {
  if (!error) return false;
  if (error instanceof QueryAbortedError) return true;
  return error.code === 'QUERY_ABORTED' || error.name === 'QueryAbortedError';
}

class ForecastMoneyValidationError extends AppError {
  constructor(cause) {
    super('Forecast money input is invalid', {
      code: 'FORECAST_MONEY_INVALID',
      status: 400,
      expose: true,
      cause,
    });
    this.name = 'ForecastMoneyValidationError';
  }
}

class ReceiptValidationError extends KnownPreApplyError {
  constructor(message = 'Receipt request is invalid') {
    super(message, { code: 'INVALID_REQUEST', status: 400 });
    this.name = 'ReceiptValidationError';
  }
}

class ReceiptPayloadTooLargeError extends KnownPreApplyError {
  constructor(message = 'Receipt image is too large') {
    super(message, { code: 'PAYLOAD_TOO_LARGE', status: 413 });
    this.name = 'ReceiptPayloadTooLargeError';
  }
}

class ReceiptUnsupportedMediaTypeError extends KnownPreApplyError {
  constructor(message = 'Receipt image format is not supported') {
    super(message, { code: 'UNSUPPORTED_MEDIA_TYPE', status: 415 });
    this.name = 'ReceiptUnsupportedMediaTypeError';
  }
}

class ReceiptDuplicateError extends KnownPreApplyError {
  constructor(message = 'This receipt image was already uploaded') {
    super(message, { code: 'RECEIPT_DUPLICATE', status: 409 });
    this.name = 'ReceiptDuplicateError';
  }
}

class ManualAssetNotFoundError extends KnownPreApplyError {
  constructor() {
    super('Manual asset not found', {
      code: 'NOT_FOUND',
      status: 404,
    });
    this.name = 'ManualAssetNotFoundError';
  }
}

class GoalLinkedAccountNotFoundError extends KnownPreApplyError {
  constructor() {
    super('Linked account not found', {
      code: 'ACCOUNT_NOT_FOUND',
      status: 404,
    });
    this.name = 'GoalLinkedAccountNotFoundError';
  }
}

class GoalLinkedAccountClosedError extends KnownPreApplyError {
  constructor() {
    super('Linked account is closed', {
      code: 'ACCOUNT_CLOSED',
      status: 409,
    });
    this.name = 'GoalLinkedAccountClosedError';
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
      { code: error.code, status: 500, expose: true, cause: error },
    );
  }
  if (error?.name === 'RuntimeStateError' || String(error?.code || '').startsWith('RUNTIME_STATE_')) {
    return new AppError(GENERIC_INTERNAL_MESSAGE, {
      code: 'RUNTIME_STATE_ERROR',
      status: 500,
      expose: false,
      cause: error,
    });
  }
  return new AppError(GENERIC_INTERNAL_MESSAGE, {
    code: GENERIC_INTERNAL_CODE,
    status: 500,
    expose: false,
    cause: error,
  });
}

module.exports = {
  AccountNotFoundError,
  admissionOverloadRequiresKeyReuse,
  AdmissionOverloadedError,
  AdmissionUnavailableError,
  AppError,
  ForecastMoneyValidationError,
  GENERIC_INTERNAL_CODE,
  GENERIC_INTERNAL_MESSAGE,
  GoalLinkedAccountClosedError,
  GoalLinkedAccountNotFoundError,
  ImportedTransactionError,
  KnownPreApplyError,
  ManualAssetNotFoundError,
  QueryAbortedError,
  isQueryAbortedError,
  QueryCursorSecretError,
  QueryRangeExceededError,
  QueryResultLimitExceededError,
  ReceiptDuplicateError,
  ReceiptPayloadTooLargeError,
  ReceiptUnsupportedMediaTypeError,
  ReceiptValidationError,
  RequestValidationError,
  SplitLegDeleteError,
  SplitParentNotFoundError,
  TransactionNotFoundError,
  classifyError,
};

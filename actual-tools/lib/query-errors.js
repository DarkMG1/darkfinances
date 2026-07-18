'use strict';

class QueryRangeExceededError extends Error {
  constructor(message = 'Requested ledger window exceeds supported bounds') {
    super(message);
    this.name = 'QueryRangeExceededError';
    this.code = 'QUERY_RANGE_EXCEEDED';
    this.status = 400;
  }
}

class QueryResultLimitExceededError extends Error {
  constructor(message = 'Requested ledger result exceeds supported bounds') {
    super(message);
    this.name = 'QueryResultLimitExceededError';
    this.code = 'QUERY_RESULT_LIMIT_EXCEEDED';
    this.status = 413;
  }
}

class QueryCursorSecretError extends Error {
  constructor(message = 'Query cursor signing secret is not configured') {
    super(message);
    this.name = 'QueryCursorSecretError';
    this.code = 'QUERY_CURSOR_SECRET_UNAVAILABLE';
    this.status = 500;
  }
}

class QueryAbortedError extends Error {
  constructor(message = 'Ledger query was aborted') {
    super(message);
    this.name = 'QueryAbortedError';
    this.code = 'QUERY_ABORTED';
    this.status = 503;
    this.requiresIdempotencyKeyReuse = false;
  }
}

module.exports = {
  QueryAbortedError,
  QueryCursorSecretError,
  QueryRangeExceededError,
  QueryResultLimitExceededError,
};

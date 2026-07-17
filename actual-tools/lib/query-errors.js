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

module.exports = {
  QueryCursorSecretError,
  QueryRangeExceededError,
  QueryResultLimitExceededError,
};

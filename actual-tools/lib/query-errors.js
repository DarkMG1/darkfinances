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

module.exports = {
  QueryRangeExceededError,
  QueryResultLimitExceededError,
};

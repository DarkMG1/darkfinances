'use strict';

const crypto = require('crypto');
const { KnownPreApplyError } = require('./errors');

const EXPORT_SCHEMA_VERSION = 1;
const ALLOCATION_POLICY_VERSION = 'pr25-explicit-v1';
const MAX_SNAPSHOT_ATTEMPTS = 4;
const MAX_EXPORT_LINKS = 10_000;
const MAX_EXPORT_FIELD_LENGTH = 500;
const MAX_EXPORT_SERIALIZED_BYTES = 8 * 1024 * 1024;
const MAX_EXPORT_WINDOW_SPAN_DAYS = 3660;

class ExportSourceChangedError extends KnownPreApplyError {
  constructor(message = 'export source changed during snapshot — refresh and retry') {
    super(message, { code: 'EXPORT_SOURCE_CHANGED', status: 409 });
    this.name = 'ExportSourceChangedError';
  }
}

class ReimbursementExportIncompleteError extends KnownPreApplyError {
  constructor(message = 'reimbursement export is incomplete or ambiguous', payload = null) {
    super(message, { code: 'REIMBURSEMENT_EXPORT_INCOMPLETE', status: 409 });
    this.name = 'ReimbursementExportIncompleteError';
    this.payload = payload;
  }
}

class ReimbursementExportBoundsError extends KnownPreApplyError {
  constructor(message = 'reimbursement export exceeds bounds', { status = 413 } = {}) {
    super(message, { code: 'REIMBURSEMENT_EXPORT_BOUNDS', status });
    this.name = 'ReimbursementExportBoundsError';
  }
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function digestStableJson(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

module.exports = {
  ALLOCATION_POLICY_VERSION,
  EXPORT_SCHEMA_VERSION,
  ExportSourceChangedError,
  MAX_EXPORT_FIELD_LENGTH,
  MAX_EXPORT_LINKS,
  MAX_EXPORT_SERIALIZED_BYTES,
  MAX_EXPORT_WINDOW_SPAN_DAYS,
  MAX_SNAPSHOT_ATTEMPTS,
  ReimbursementExportBoundsError,
  ReimbursementExportIncompleteError,
  digestStableJson,
  stableStringify,
};

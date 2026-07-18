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

const EXPORT_AUTHORITATIVE_CENT_KEYS = Object.freeze([
  'allocationCents',
  'amountCents',
  'absCapCents',
  'allocatedTrustedCents',
  'remainingTrustedCents',
  'remainingWindowTrustedCents',
  'trustedAllocationCents',
]);

class ExportSourceChangedError extends KnownPreApplyError {
  constructor(message = 'export source changed during snapshot — refresh and retry') {
    super(message, { code: 'EXPORT_SOURCE_CHANGED', status: 409 });
    this.name = 'ExportSourceChangedError';
  }
}

class ReimbursementExportIncompleteError extends KnownPreApplyError {
  constructor(message = 'reimbursement export is incomplete or ambiguous', {
    incompleteReasons = [],
    incompleteSections = [],
  } = {}) {
    super(message, { code: 'REIMBURSEMENT_EXPORT_INCOMPLETE', status: 409 });
    this.name = 'ReimbursementExportIncompleteError';
    this.incompleteReasons = incompleteReasons;
    this.incompleteSections = incompleteSections;
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

function isAuthoritativeCentKey(key) {
  return EXPORT_AUTHORITATIVE_CENT_KEYS.includes(key);
}

function withholdExportLinkRow(row) {
  if (!row || typeof row !== 'object') return row;
  return {
    ...row,
    allocationCents: null,
    inflow: row.inflow ? { ...row.inflow, amountCents: null } : row.inflow,
    expense: row.expense ? { ...row.expense, amountCents: null } : row.expense,
  };
}

function withholdExportEndpointScope(scope) {
  if (!scope || typeof scope !== 'object') return scope;
  return {
    ...scope,
    absCapCents: null,
    allocatedTrustedCents: null,
    remainingTrustedCents: null,
    remainingWindowTrustedCents: null,
    ambiguousLinkCount: null,
  };
}

function withholdExportEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'object') return endpoint;
  const next = { ...endpoint, amountCents: null };
  if (next.global) next.global = withholdExportEndpointScope(next.global);
  if (next.window) {
    next.window = {
      ...next.window,
      allocatedTrustedCents: null,
    };
  }
  return next;
}

function withholdExportScopeTotals(totals) {
  if (!totals || typeof totals !== 'object') return totals;
  return {
    ...totals,
    trustedAllocationCents: null,
    authoritative: false,
  };
}

function withholdAuthoritativeExportPayload(payload) {
  const clone = JSON.parse(JSON.stringify(payload));
  const mapLinks = (rows) => (rows || []).map(withholdExportLinkRow);

  clone.links = mapLinks(clone.links);
  if (clone.scopes?.global) {
    clone.scopes.global.links = mapLinks(clone.scopes.global.links);
    if (clone.scopes.global.totals) {
      clone.scopes.global.totals = withholdExportScopeTotals(clone.scopes.global.totals);
    }
  }
  if (clone.scopes?.window) {
    clone.scopes.window.links = mapLinks(clone.scopes.window.links);
    if (clone.scopes.window.totals) {
      clone.scopes.window.totals = withholdExportScopeTotals(clone.scopes.window.totals);
    }
  }

  clone.totals = {
    ...(clone.totals || {}),
    trustedAllocationCents: null,
    authoritative: false,
  };
  clone.people = (clone.people || []).map((row) => ({
    person: row.person,
    allocatedTrustedCents: null,
  }));
  clone.endpoints = Object.fromEntries(
    Object.entries(clone.endpoints || {}).map(([id, endpoint]) => [id, withholdExportEndpoint(endpoint)]),
  );
  return clone;
}

function collectLeakedAuthoritativeCents(value, path = '$', leaks = []) {
  if (value == null || typeof value !== 'object') return leaks;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectLeakedAuthoritativeCents(entry, `${path}[${index}]`, leaks));
    return leaks;
  }
  for (const [key, child] of Object.entries(value)) {
    if (isAuthoritativeCentKey(key) && child != null && Number.isSafeInteger(child)) {
      leaks.push({ path: `${path}.${key}`, value: child });
    } else if (child != null && typeof child === 'object') {
      collectLeakedAuthoritativeCents(child, `${path}.${key}`, leaks);
    }
  }
  return leaks;
}

function actionableIncompleteReasonCodes(reasons) {
  return [...new Set((reasons || []).map((reason) => reason?.code).filter(Boolean))].sort();
}

function sanitizeIncompleteSectionsForError(sections) {
  function walk(value) {
    if (value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((entry) => walk(entry));
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (isAuthoritativeCentKey(key)) continue;
      out[key] = walk(child);
    }
    return out;
  }
  return walk(sections || []);
}

function summarizeExportIncompleteForError(payload) {
  return {
    incompleteReasons: actionableIncompleteReasonCodes(payload?.completeness?.reasons),
    incompleteSections: sanitizeIncompleteSectionsForError(payload?.incompleteSections),
  };
}

function exportExitCodeFromPayload(payload) {
  if (!payload) return 1;
  return payload.completeness?.status === 'complete' ? 0 : 2;
}

function buildReimbursementExportV1Envelope(payload) {
  return stableStringify({
    data: payload,
    meta: {
      exitCode: exportExitCodeFromPayload(payload),
      completeness: payload.completeness.status,
      authoritative: payload.totals.authoritative,
    },
  });
}

module.exports = {
  ALLOCATION_POLICY_VERSION,
  EXPORT_AUTHORITATIVE_CENT_KEYS,
  EXPORT_SCHEMA_VERSION,
  ExportSourceChangedError,
  MAX_EXPORT_FIELD_LENGTH,
  MAX_EXPORT_LINKS,
  MAX_EXPORT_SERIALIZED_BYTES,
  MAX_EXPORT_WINDOW_SPAN_DAYS,
  MAX_SNAPSHOT_ATTEMPTS,
  ReimbursementExportBoundsError,
  ReimbursementExportIncompleteError,
  actionableIncompleteReasonCodes,
  buildReimbursementExportV1Envelope,
  collectLeakedAuthoritativeCents,
  digestStableJson,
  exportExitCodeFromPayload,
  isAuthoritativeCentKey,
  sanitizeIncompleteSectionsForError,
  stableStringify,
  summarizeExportIncompleteForError,
  withholdAuthoritativeExportPayload,
  withholdExportEndpoint,
  withholdExportLinkRow,
  withholdExportScopeTotals,
};

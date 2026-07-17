'use strict';

const MAX_PRINCIPAL_ENTRIES_CAP = 4096;

const DEFAULTS = Object.freeze({
  mutationGlobalPending: 32,
  mutationGlobalRunning: 1,
  mutationPrincipalPending: 8,
  mutationPrincipalRunning: 1,
  readGlobalPending: 48,
  readGlobalRunning: 4,
  readPrincipalPending: 12,
  readPrincipalRunning: 2,
  lightweightGlobalPending: 16,
  lightweightGlobalRunning: 4,
  lightweightPrincipalPending: 8,
  lightweightPrincipalRunning: 2,
  maxPendingDepth: 64,
  maxPrincipalEntries: 256,
  controlReserve: 4,
  recoveryReserve: 4,
  cheapReserve: 8,
  maxWaitMs: 30_000,
  maxPendingAgeMs: 60_000,
  defaultEndpointWeight: 1,
  maxEndpointWeight: 8,
});

const INT_FIELDS = [
  'mutationGlobalPending',
  'mutationGlobalRunning',
  'mutationPrincipalPending',
  'mutationPrincipalRunning',
  'readGlobalPending',
  'readGlobalRunning',
  'readPrincipalPending',
  'readPrincipalRunning',
  'lightweightGlobalPending',
  'lightweightGlobalRunning',
  'lightweightPrincipalPending',
  'lightweightPrincipalRunning',
  'maxPendingDepth',
  'maxPrincipalEntries',
  'controlReserve',
  'recoveryReserve',
  'cheapReserve',
  'maxWaitMs',
  'maxPendingAgeMs',
  'defaultEndpointWeight',
  'maxEndpointWeight',
];

const ENV_MAP = Object.freeze({
  mutationGlobalPending: 'FINANCE_ADMISSION_MUTATION_GLOBAL_PENDING',
  mutationGlobalRunning: 'FINANCE_ADMISSION_MUTATION_GLOBAL_RUNNING',
  mutationPrincipalPending: 'FINANCE_ADMISSION_MUTATION_PRINCIPAL_PENDING',
  mutationPrincipalRunning: 'FINANCE_ADMISSION_MUTATION_PRINCIPAL_RUNNING',
  readGlobalPending: 'FINANCE_ADMISSION_READ_GLOBAL_PENDING',
  readGlobalRunning: 'FINANCE_ADMISSION_READ_GLOBAL_RUNNING',
  readPrincipalPending: 'FINANCE_ADMISSION_READ_PRINCIPAL_PENDING',
  readPrincipalRunning: 'FINANCE_ADMISSION_READ_PRINCIPAL_RUNNING',
  lightweightGlobalPending: 'FINANCE_ADMISSION_LIGHTWEIGHT_GLOBAL_PENDING',
  lightweightGlobalRunning: 'FINANCE_ADMISSION_LIGHTWEIGHT_GLOBAL_RUNNING',
  lightweightPrincipalPending: 'FINANCE_ADMISSION_LIGHTWEIGHT_PRINCIPAL_PENDING',
  lightweightPrincipalRunning: 'FINANCE_ADMISSION_LIGHTWEIGHT_PRINCIPAL_RUNNING',
  maxPendingDepth: 'FINANCE_ADMISSION_MAX_PENDING_DEPTH',
  maxPrincipalEntries: 'FINANCE_ADMISSION_MAX_PRINCIPAL_ENTRIES',
  controlReserve: 'FINANCE_ADMISSION_CONTROL_RESERVE',
  recoveryReserve: 'FINANCE_ADMISSION_RECOVERY_RESERVE',
  cheapReserve: 'FINANCE_ADMISSION_CHEAP_RESERVE',
  maxWaitMs: 'FINANCE_ADMISSION_MAX_WAIT_MS',
  maxPendingAgeMs: 'FINANCE_ADMISSION_MAX_PENDING_AGE_MS',
  defaultEndpointWeight: 'FINANCE_ADMISSION_DEFAULT_ENDPOINT_WEIGHT',
  maxEndpointWeight: 'FINANCE_ADMISSION_MAX_ENDPOINT_WEIGHT',
});

function parseNonNegativeInt(raw, fieldName, { allowZero = false } = {}) {
  if (raw == null || raw === '') return null;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || (!allowZero && parsed < 1)) {
    throw new Error(`${fieldName} must be a ${allowZero ? 'non-negative' : 'positive'} integer`);
  }
  return parsed;
}

function parsePositiveInt(raw, fieldName) {
  return parseNonNegativeInt(raw, fieldName, { allowZero: false });
}

function parseEndpointWeights(raw, maxEndpointWeight) {
  if (raw == null || String(raw).trim() === '') return Object.create(null);
  const weights = Object.create(null);
  for (const entry of String(raw).split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0 || colon >= trimmed.length - 1) {
      throw new Error('FINANCE_ADMISSION_ENDPOINT_WEIGHTS entries must be endpoint:weight');
    }
    const endpoint = trimmed.slice(0, colon).trim().toLowerCase();
    const weight = parsePositiveInt(trimmed.slice(colon + 1).trim(), 'FINANCE_ADMISSION_ENDPOINT_WEIGHTS weight');
    if (!/^[a-z0-9._/-]{1,64}$/.test(endpoint)) {
      throw new Error('FINANCE_ADMISSION_ENDPOINT_WEIGHTS endpoint must match /^[a-z0-9._/-]{1,64}$/');
    }
    if (weight > maxEndpointWeight) {
      throw new Error(`FINANCE_ADMISSION_ENDPOINT_WEIGHTS weight for ${endpoint} exceeds max ${maxEndpointWeight}`);
    }
    weights[endpoint] = weight;
  }
  return weights;
}

function validateConfig(config) {
  if (config.mutationGlobalRunning > config.mutationGlobalPending) {
    throw new Error('mutation global running cannot exceed global pending');
  }
  if (config.mutationPrincipalRunning > config.mutationPrincipalPending) {
    throw new Error('mutation principal running cannot exceed principal pending');
  }
  if (config.readGlobalRunning > config.readGlobalPending) {
    throw new Error('read global running cannot exceed global pending');
  }
  if (config.readPrincipalRunning > config.readPrincipalPending) {
    throw new Error('read principal running cannot exceed principal pending');
  }
  if (config.lightweightGlobalRunning > config.lightweightGlobalPending) {
    throw new Error('lightweight global running cannot exceed global pending');
  }
  if (config.lightweightPrincipalRunning > config.lightweightPrincipalPending) {
    throw new Error('lightweight principal running cannot exceed principal pending');
  }
  if (config.maxPrincipalEntries > MAX_PRINCIPAL_ENTRIES_CAP) {
    throw new Error(`maxPrincipalEntries cannot exceed ${MAX_PRINCIPAL_ENTRIES_CAP}`);
  }
  if (config.controlReserve >= config.mutationGlobalPending && config.controlReserve > 0) {
    throw new Error('control reserve must be smaller than mutation global pending');
  }
  if (config.controlReserve >= config.readGlobalPending && config.controlReserve > 0) {
    throw new Error('control reserve must be smaller than read global pending');
  }
  if (config.recoveryReserve >= config.mutationGlobalPending && config.recoveryReserve > 0) {
    throw new Error('recovery reserve must be smaller than mutation global pending');
  }
  if (config.cheapReserve >= config.readGlobalPending && config.cheapReserve > 0) {
    throw new Error('cheap reserve must be smaller than read global pending');
  }
  const mutationOrdinaryCap = config.mutationGlobalPending - config.controlReserve - config.recoveryReserve;
  if (mutationOrdinaryCap < config.mutationGlobalRunning) {
    throw new Error('mutation ordinary capacity is smaller than global running');
  }
  const readOrdinaryCap = config.readGlobalPending - config.controlReserve - config.cheapReserve;
  if (readOrdinaryCap < config.readGlobalRunning) {
    throw new Error('read ordinary capacity is smaller than global running');
  }
  if (config.maxPendingDepth < config.mutationGlobalRunning) {
    throw new Error('max pending depth must be at least mutation global running');
  }
  if (config.maxPendingDepth < config.readGlobalRunning) {
    throw new Error('max pending depth must be at least read global running');
  }
  if (config.maxPendingDepth < config.lightweightGlobalRunning) {
    throw new Error('max pending depth must be at least lightweight global running');
  }
  return config;
}

function loadAdmissionLimitsConfig(env = process.env) {
  const config = { ...DEFAULTS };
  for (const field of INT_FIELDS) {
    const reserveField = field === 'controlReserve' || field === 'recoveryReserve' || field === 'cheapReserve';
    const parsed = reserveField
      ? parseNonNegativeInt(env[ENV_MAP[field]], ENV_MAP[field], { allowZero: true })
      : parsePositiveInt(env[ENV_MAP[field]], ENV_MAP[field]);
    if (parsed != null) config[field] = parsed;
  }
  config.endpointWeights = parseEndpointWeights(
    env.FINANCE_ADMISSION_ENDPOINT_WEIGHTS,
    config.maxEndpointWeight,
  );
  return validateConfig(Object.freeze(config));
}

module.exports = {
  DEFAULTS,
  ENV_MAP,
  MAX_PRINCIPAL_ENTRIES_CAP,
  loadAdmissionLimitsConfig,
  parseEndpointWeights,
  validateConfig,
};

'use strict';

const PRODUCTION_RUNTIME_MODE = 'production';
const TEST_RUNTIME_MODE = 'test';

const RAW_ACTUAL_API_BYPASS_ENV = 'ALLOW_RAW_ACTUAL_API';
const DEV_CURSOR_FALLBACK = 'finance-query-cursor-dev-only';

/** Exact env flags forbidden in production runtime (value must match). */
const PRODUCTION_FORBIDDEN_EXACT_FLAGS = Object.freeze([
  { key: RAW_ACTUAL_API_BYPASS_ENV, forbiddenValues: ['1'] },
  { key: 'SELFTEST', forbiddenValues: ['1'] },
  { key: 'DEMO_ONLY', forbiddenValues: ['1'] },
]);

/** Env keys forbidden in production runtime when set to any non-empty value. */
const PRODUCTION_FORBIDDEN_IF_SET = Object.freeze([
  'TEST_SERVER_INSTANCE_ID',
  'FINANCE_QUERY_TEST_BARRIER_DIR',
  'FINANCE_QUERY_TEST_FETCH_DELAY_MS',
  'FINANCE_QUERY_TEST_ACCOUNT_COUNT',
  'FINANCE_QUERY_TEST_ROWS_PER_ACCOUNT',
]);

const PRODUCTION_FORBIDDEN_ENV_PREFIX = 'FINANCE_QUERY_TEST_';

const PRODUCTION_RUNTIME_CONFLICT_ERROR =
  'Production runtime rejects conflicting test runtime configuration';

const PRODUCTION_RUNTIME_FORBIDDEN_FLAGS_ERROR =
  'Production runtime rejects test-only configuration flags';

const PRODUCTION_RUNTIME_CURSOR_SIGNING_ERROR =
  'Production runtime requires explicit query cursor signing';

const PRODUCTION_RELEASE_KEYRING_ERROR =
  'Production runtime requires RELEASE_KEYRING_PATH';

/** @deprecated use PRODUCTION_RUNTIME_FORBIDDEN_FLAGS_ERROR */
const PRODUCTION_RUNTIME_MISCONFIG_ERROR = PRODUCTION_RUNTIME_FORBIDDEN_FLAGS_ERROR;

const RAW_API_BLOCKED_ERROR =
  'Direct data.api access bypasses the Actual coordinator; use runActualRead/runActualWrite or set ALLOW_RAW_ACTUAL_API=1 in test runtime only';

function normalizeEnvValue(raw) {
  if (raw == null || raw === '') return undefined;
  return String(raw);
}

function isProductionRuntime(env = process.env) {
  const runtimeMode = normalizeEnvValue(env.FINANCE_RUNTIME_MODE);
  const nodeEnv = normalizeEnvValue(env.NODE_ENV);
  return runtimeMode === PRODUCTION_RUNTIME_MODE || nodeEnv === 'production';
}

function isTestRuntime(env = process.env) {
  if (isProductionRuntime(env)) return false;
  const runtimeMode = normalizeEnvValue(env.FINANCE_RUNTIME_MODE);
  const nodeEnv = normalizeEnvValue(env.NODE_ENV);
  return runtimeMode === TEST_RUNTIME_MODE || nodeEnv === 'test';
}

function isValidStableCursorSecret(value) {
  const text = String(value || '').trim();
  return text.length >= 8 && text !== DEV_CURSOR_FALLBACK;
}

function collectProductionRuntimeConflicts(env = process.env) {
  if (!isProductionRuntime(env)) return [];
  const conflicts = [];
  if (normalizeEnvValue(env.NODE_ENV) === TEST_RUNTIME_MODE) {
    conflicts.push('NODE_ENV');
  }
  if (normalizeEnvValue(env.FINANCE_RUNTIME_MODE) === TEST_RUNTIME_MODE) {
    conflicts.push('FINANCE_RUNTIME_MODE');
  }
  return conflicts;
}

function collectProductionForbiddenFlags(env = process.env) {
  const found = [];
  for (const { key, forbiddenValues } of PRODUCTION_FORBIDDEN_EXACT_FLAGS) {
    const value = normalizeEnvValue(env[key]);
    if (value != null && forbiddenValues.includes(value)) {
      found.push(key);
    }
  }
  for (const key of PRODUCTION_FORBIDDEN_IF_SET) {
    if (normalizeEnvValue(env[key]) != null) {
      found.push(key);
    }
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith(PRODUCTION_FORBIDDEN_ENV_PREFIX) && normalizeEnvValue(env[key]) != null) {
      found.push(key);
    }
  }
  return found;
}

function assertProductionReleaseKeyring(env = process.env) {
  if (!isProductionRuntime(env)) return;
  if (!normalizeEnvValue(env.RELEASE_KEYRING_PATH)) {
    throw new Error(PRODUCTION_RELEASE_KEYRING_ERROR);
  }
}

function assertProductionReleaseEvidence(env = process.env) {
  assertProductionReleaseKeyring(env);
}

function collectProductionDeploymentEnvIssues(env = process.env) {
  const issues = [];
  if (isProductionRuntime(env) && !normalizeEnvValue(env.RELEASE_KEYRING_PATH)) {
    issues.push('RELEASE_KEYRING_PATH');
  }
  return issues;
}
function assertProductionCursorSigning(env = process.env) {
  if (!isProductionRuntime(env)) return;
  if (isProductionCursorSigningConfigured(env)) return;
  throw new Error(PRODUCTION_RUNTIME_CURSOR_SIGNING_ERROR);
}

function isProductionCursorSigningConfigured(env = process.env) {
  const explicit = String(env.FINANCE_QUERY_CURSOR_SECRET || '').trim();
  if (explicit) return isValidStableCursorSecret(explicit);
  const syncId = String(env.ACTUAL_SYNC_ID || '').trim();
  if (syncId) return isValidStableCursorSecret(syncId);
  return false;
}

function assertProductionRuntimeSafe(env = process.env) {
  if (!isProductionRuntime(env)) return;
  if (collectProductionRuntimeConflicts(env).length > 0) {
    throw new Error(PRODUCTION_RUNTIME_CONFLICT_ERROR);
  }
  if (collectProductionForbiddenFlags(env).length > 0) {
    throw new Error(PRODUCTION_RUNTIME_FORBIDDEN_FLAGS_ERROR);
  }
  assertProductionCursorSigning(env);
  assertProductionReleaseEvidence(env);
}

function isRawActualApiAllowed(env = process.env) {
  if (!isTestRuntime(env)) return false;
  return normalizeEnvValue(env[RAW_ACTUAL_API_BYPASS_ENV]) === '1';
}

function parseDeploymentEnvFile(content) {
  const env = {};
  for (const line of String(content).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function lintDeploymentEnv(content, { assumeProduction = true } = {}) {
  const env = parseDeploymentEnvFile(content);
  if (assumeProduction) {
    if (!normalizeEnvValue(env.FINANCE_RUNTIME_MODE)) {
      env.FINANCE_RUNTIME_MODE = PRODUCTION_RUNTIME_MODE;
    }
    if (!normalizeEnvValue(env.NODE_ENV)) {
      env.NODE_ENV = PRODUCTION_RUNTIME_MODE;
    }
  }
  assertProductionRuntimeSafe(env);
  const missing = collectProductionDeploymentEnvIssues(env);
  if (missing.length > 0) {
    throw new Error(`Production deployment env is missing required keys: ${missing.join(', ')}`);
  }
  return env;
}

function stripProductionUnsafeEnv(env = process.env) {
  const cleaned = { ...env };
  for (const { key } of PRODUCTION_FORBIDDEN_EXACT_FLAGS) {
    delete cleaned[key];
  }
  for (const key of PRODUCTION_FORBIDDEN_IF_SET) {
    delete cleaned[key];
  }
  for (const key of Object.keys(cleaned)) {
    if (key.startsWith(PRODUCTION_FORBIDDEN_ENV_PREFIX)) {
      delete cleaned[key];
    }
  }
  if (normalizeEnvValue(cleaned.FINANCE_RUNTIME_MODE) === TEST_RUNTIME_MODE) {
    delete cleaned.FINANCE_RUNTIME_MODE;
  }
  if (normalizeEnvValue(cleaned.NODE_ENV) === TEST_RUNTIME_MODE) {
    delete cleaned.NODE_ENV;
  }
  return cleaned;
}

/** @deprecated use stripProductionUnsafeEnv */
function stripProductionForbiddenFlags(env = process.env) {
  return stripProductionUnsafeEnv(env);
}

module.exports = {
  DEV_CURSOR_FALLBACK,
  PRODUCTION_FORBIDDEN_EXACT_FLAGS,
  PRODUCTION_FORBIDDEN_IF_SET,
  PRODUCTION_RELEASE_KEYRING_ERROR,
  PRODUCTION_RUNTIME_CONFLICT_ERROR,
  PRODUCTION_RUNTIME_CURSOR_SIGNING_ERROR,
  PRODUCTION_RUNTIME_FORBIDDEN_FLAGS_ERROR,
  PRODUCTION_RUNTIME_MISCONFIG_ERROR,
  PRODUCTION_RUNTIME_MODE,
  RAW_ACTUAL_API_BYPASS_ENV,
  RAW_API_BLOCKED_ERROR,
  TEST_RUNTIME_MODE,
  assertProductionCursorSigning,
  assertProductionReleaseEvidence,
  assertProductionReleaseKeyring,
  assertProductionRuntimeSafe,
  collectProductionDeploymentEnvIssues,
  collectProductionForbiddenFlags,
  collectProductionRuntimeConflicts,
  isProductionCursorSigningConfigured,
  isProductionRuntime,
  isRawActualApiAllowed,
  isTestRuntime,
  isValidStableCursorSecret,
  lintDeploymentEnv,
  parseDeploymentEnvFile,
  stripProductionForbiddenFlags,
  stripProductionUnsafeEnv,
};

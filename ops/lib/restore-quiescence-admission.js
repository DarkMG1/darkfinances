'use strict';

const fs = require('fs');
const crypto = require('crypto');

const ADMISSION_KIND = 'darkfinances-restore-quiescence-admission';
const ADMISSION_SCHEMA_VERSION = 1;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseAdmissionToken(text, label = 'quiescence admission token') {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`${label} must be a JSON object`);
  if (parsed.kind !== ADMISSION_KIND) throw new Error(`${label} kind mismatch`);
  if (parsed.schemaVersion !== ADMISSION_SCHEMA_VERSION) {
    throw new Error(`${label} schemaVersion ${parsed.schemaVersion} is unsupported`);
  }
  if (parsed.admitted !== true) throw new Error(`${label} is not admitted`);
  if (typeof parsed.issuedAt !== 'string' || !parsed.issuedAt) {
    throw new Error(`${label} requires issuedAt`);
  }
  if (typeof parsed.token !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.token)) {
    throw new Error(`${label} requires token sha256 digest`);
  }
  if (!isPlainObject(parsed.writers)) throw new Error(`${label} writers must be an object`);
  for (const [name, state] of Object.entries(parsed.writers)) {
    if (typeof state !== 'string' || !['stopped', 'inactive', 'not-present'].includes(state)) {
      throw new Error(`${label} writer ${name} has invalid state ${state}`);
    }
  }
  return parsed;
}

function admissionTokenFromEnv(env = process.env) {
  const inline = env.RESTORE_QUIESCENCE_ADMISSION_TOKEN;
  if (inline) return parseAdmissionToken(inline, 'RESTORE_QUIESCENCE_ADMISSION_TOKEN');
  const tokenPath = env.RESTORE_QUIESCENCE_ADMISSION_PATH;
  if (tokenPath) {
    if (!fs.existsSync(tokenPath)) {
      throw new Error(`quiescence admission token file not found: ${tokenPath}`);
    }
    return parseAdmissionToken(fs.readFileSync(tokenPath, 'utf8'), tokenPath);
  }
  return null;
}

function requireQuiescenceAdmission(options = {}) {
  if (options.skipQuiescenceAdmission === true) return null;
  const token = admissionTokenFromEnv(options.env || process.env);
  if (!token) {
    throw new Error('restore refused: missing quiescence admission token (PR-18 owns writer quiescence)');
  }
  return token;
}

function buildTestAdmissionToken(writers = {}) {
  const payload = {
    schemaVersion: ADMISSION_SCHEMA_VERSION,
    kind: ADMISSION_KIND,
    admitted: true,
    issuedAt: new Date().toISOString(),
    writers: {
      'finance-dashboard': 'stopped',
      'actual-sync': 'stopped',
      ...writers,
    },
  };
  payload.token = crypto.createHash('sha256').update(`${JSON.stringify({
    schemaVersion: payload.schemaVersion,
    kind: payload.kind,
    admitted: payload.admitted,
    issuedAt: payload.issuedAt,
    writers: payload.writers,
  })}\n`).digest('hex');
  return payload;
}

module.exports = {
  ADMISSION_KIND,
  ADMISSION_SCHEMA_VERSION,
  admissionTokenFromEnv,
  requireQuiescenceAdmission,
  parseAdmissionToken,
  buildTestAdmissionToken,
};

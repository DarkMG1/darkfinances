'use strict';

const fs = require('fs');
const path = require('path');
const { JsonStoreError, readJsonFile, writeJsonFile, quarantineCorruptFile } = require('./json-store');
const { STATE_REGISTRY, statePath } = require('./state-registry');
const {
  schemaForRegistryEntry,
  cloneJson,
  validateCallerInvariant,
} = require('./runtime-state-schemas');
const { enforceUnknownFieldPolicy } = require('./runtime-state-field-policy');
const {
  SEMANTIC_STORES,
  assertWriteGuards,
  normalizeSagaTerminalEvidence,
  semanticValidator,
  validateSemantic,
  validateStrictWrite,
} = require('./runtime-state-semantics');

class RuntimeStateError extends Error {
  constructor(message, { code = 'RUNTIME_STATE_ERROR', file, cause, details } = {}) {
    super(message, { cause });
    this.name = 'RuntimeStateError';
    this.code = code;
    this.file = file;
    this.details = details;
  }
}

const writeGuards = new Map();

function lastGoodPath(file) {
  return `${file}.last-good`;
}

function resetWriteGuards() {
  writeGuards.clear();
}

function markWriteGuard(file, reason) {
  writeGuards.set(file, reason);
}

function assertWritable(file) {
  if (writeGuards.has(file)) {
    throw new RuntimeStateError(`Refusing to write ${path.basename(file)} after invalid read`, {
      code: 'RUNTIME_STATE_WRITE_BLOCKED',
      file,
      details: { reason: writeGuards.get(file) },
    });
  }
}

function filenameToRegistryKey(filename) {
  for (const [name, definition] of Object.entries(STATE_REGISTRY)) {
    if (definition.filename === filename) return name;
  }
  return null;
}

function readRawFile(file) {
  try {
    return { kind: 'present', raw: fs.readFileSync(file, 'utf8') };
  } catch (cause) {
    if (cause && cause.code === 'ENOENT') return { kind: 'missing' };
    throw new RuntimeStateError(`Could not read ${path.basename(file)}`, {
      code: 'RUNTIME_STATE_READ_FAILED',
      file,
      cause,
    });
  }
}

function parseJson(file, raw) {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    return { kind: 'corrupt', cause };
  }
}

function registryNameForPath(targetPath, env = process.env) {
  const normalized = path.resolve(targetPath);
  for (const [name, definition] of Object.entries(STATE_REGISTRY)) {
    if (path.resolve(statePath(name, env)) === normalized) return name;
  }
  return null;
}

function resolveTarget(name, env, file) {
  const definition = STATE_REGISTRY[name];
  if (!definition) {
    throw new RuntimeStateError(`Unknown runtime state: ${name}`, { code: 'RUNTIME_STATE_UNKNOWN' });
  }
  return {
    definition,
    schema: schemaForRegistryEntry(name),
    file: file || statePath(name, env),
  };
}

function applyPostSchemaValidation(name, value, file, { validate, semanticMode, raw, schema, previous }) {
  try {
    enforceUnknownFieldPolicy(name, raw, value, schema);
  } catch (cause) {
    quarantineCorruptFile(file);
    markWriteGuard(file, 'unknown-field-policy');
    throw new RuntimeStateError(cause.message, {
      code: cause.code || 'RUNTIME_STATE_UNKNOWN_FIELD',
      file,
      cause,
    });
  }
  if (!validateCallerInvariant(name, value)) {
    quarantineCorruptFile(file);
    markWriteGuard(file, 'caller-invariant-failed');
    throw new RuntimeStateError(`Unexpected JSON shape in ${path.basename(file)}`, {
      code: 'RUNTIME_STATE_INVALID_SHAPE',
      file,
      details: { name, reason: 'caller-invariant' },
    });
  }
  if (typeof validate === 'function' && !validate(value)) {
    quarantineCorruptFile(file);
    markWriteGuard(file, 'caller-validate-failed');
    throw new RuntimeStateError(`Unexpected JSON shape in ${path.basename(file)}`, {
      code: 'RUNTIME_STATE_INVALID_SHAPE',
      file,
      details: { name, reason: 'caller-validate' },
    });
  }
  if (semanticMode !== 'skip' && semanticValidator(name)) {
    try {
      validateSemantic(name, value, { mode: semanticMode, previous });
    } catch (cause) {
      quarantineCorruptFile(file);
      markWriteGuard(file, 'semantic-validation-failed');
      throw new RuntimeStateError(cause.message, {
        code: 'RUNTIME_STATE_SEMANTIC_INVALID',
        file,
        cause,
      });
    }
  }
  return value;
}

function loadParsedValue(name, parsed, schema, file, {
  allowLastGood = true,
  validate,
  semanticMode = 'read',
} = {}) {
  let migrated;
  try {
    migrated = schema.migrate(parsed);
  } catch (cause) {
    if (cause?.code === 'RUNTIME_STATE_FUTURE_SCHEMA') {
      throw new RuntimeStateError(cause.message, { code: cause.code, file, cause });
    }
    if (cause?.name === 'SplitwiseMirrorResolutionError') {
      quarantineCorruptFile(file);
      markWriteGuard(file, 'invalid-primary');
      throw cause;
    }
    quarantineCorruptFile(file);
    if (allowLastGood && schema.lastGoodPolicy === 'allow-on-primary-invalid') {
      return recoverFromLastGood(name, schema, file, { validate, semanticMode });
    }
    markWriteGuard(file, 'migration-failed');
    throw cause instanceof RuntimeStateError ? cause : new RuntimeStateError(
      `Refusing invalid ${path.basename(file)} primary payload`,
      { code: cause.code || 'RUNTIME_STATE_MIGRATION_FAILED', file, cause },
    );
  }

  if (!schema.validateCurrent(migrated.value)) {
    quarantineCorruptFile(file);
    if (allowLastGood && schema.lastGoodPolicy === 'allow-on-primary-invalid') {
      return recoverFromLastGood(name, schema, file, { validate, semanticMode });
    }
    markWriteGuard(file, 'invalid-current-shape');
    throw new RuntimeStateError(`Unexpected JSON shape in ${path.basename(file)}`, {
      code: 'RUNTIME_STATE_INVALID_SHAPE',
      file,
    });
  }

  const value = applyPostSchemaValidation(
    name,
    cloneJson(migrated.value),
    file,
    { validate, semanticMode, raw: parsed, schema },
  );

  writeGuards.delete(file);
  return {
    value,
    meta: {
      source: 'primary',
      migrated: migrated.changed === true,
      file,
      name,
    },
  };
}

function recoverFromLastGood(name, schema, file, { validate, semanticMode = 'read' } = {}) {
  const sidecar = lastGoodPath(file);
  if (!fs.existsSync(sidecar)) {
    markWriteGuard(file, 'invalid-primary-no-last-good');
    throw new RuntimeStateError(`Refusing invalid ${path.basename(file)} with no validated .last-good`, {
      code: 'RUNTIME_STATE_INVALID_SHAPE',
      file,
    });
  }

  const raw = readRawFile(sidecar);
  if (raw.kind !== 'present') {
    markWriteGuard(file, 'invalid-primary-no-last-good');
    throw new RuntimeStateError(`Missing validated .last-good for ${path.basename(file)}`, {
      code: 'RUNTIME_STATE_LAST_GOOD_MISSING',
      file,
    });
  }

  const parsed = parseJson(sidecar, raw.raw);
  if (parsed.kind === 'corrupt') {
    markWriteGuard(file, 'invalid-last-good');
    throw new RuntimeStateError(`Refusing corrupt .last-good for ${path.basename(file)}`, {
      code: 'RUNTIME_STATE_LAST_GOOD_INVALID',
      file,
      cause: parsed.cause,
    });
  }

  const migrated = schema.migrate(parsed);
  if (!schema.validateCurrent(migrated.value)) {
    markWriteGuard(file, 'invalid-last-good');
    throw new RuntimeStateError(`Refusing invalid .last-good for ${path.basename(file)}`, {
      code: 'RUNTIME_STATE_LAST_GOOD_INVALID',
      file,
    });
  }

  const value = applyPostSchemaValidation(
    name,
    cloneJson(migrated.value),
    file,
    { validate, semanticMode, raw: parsed, schema },
  );

  writeGuards.delete(file);
  return {
    value,
    meta: {
      source: 'last-good',
      migrated: migrated.changed === true,
      quarantinedPrimary: file,
      file,
      name,
    },
  };
}

function readRuntimeState(name, {
  env = process.env,
  file,
  readJson = readJsonFile,
  validate,
  semantic = true,
} = {}) {
  const { schema, file: targetFile } = resolveTarget(name, env, file);
  const semanticMode = semantic ? 'read' : 'skip';
  const primary = readRawFile(targetFile);

  if (primary.kind === 'missing') {
    writeGuards.delete(targetFile);
    const missing = schema.optionalMissing
      ? schema.missingValue()
      : cloneJson(schema.missingValue());
    if (missing != null) {
      applyPostSchemaValidation(name, missing, targetFile, {
        validate,
        semanticMode: semantic ? 'read' : 'skip',
        raw: null,
        schema,
      });
    }
    return {
      value: missing,
      meta: {
        source: schema.optionalMissing ? 'missing' : 'missing-default',
        file: targetFile,
        name,
      },
    };
  }

  const parsed = parseJson(targetFile, primary.raw);
  if (parsed.kind === 'corrupt') {
    quarantineCorruptFile(targetFile);
    if (schema.lastGoodPolicy === 'allow-on-primary-invalid') {
      return recoverFromLastGood(name, schema, targetFile, {
        validate,
        semanticMode: semantic ? 'read' : 'skip',
      });
    }
    markWriteGuard(targetFile, 'corrupt-primary');
    throw new RuntimeStateError(`Refusing to overwrite corrupt JSON in ${path.basename(targetFile)}`, {
      code: 'RUNTIME_STATE_CORRUPT',
      file: targetFile,
      cause: parsed.cause,
    });
  }

  return loadParsedValue(name, parsed, schema, targetFile, {
    validate,
    semanticMode: semantic ? 'read' : 'skip',
  });
}

function readExistingForWriteGuard(name, targetFile, env) {
  try {
    return readRuntimeState(name, {
      env,
      file: targetFile,
      semantic: true,
    }).value;
  } catch (cause) {
    if (cause instanceof RuntimeStateError
      && (cause.code === 'RUNTIME_STATE_CORRUPT'
        || cause.code === 'RUNTIME_STATE_INVALID_SHAPE'
        || cause.code === 'RUNTIME_STATE_SEMANTIC_INVALID'
        || cause.code === 'RUNTIME_STATE_MIGRATION_FAILED')) {
      throw new RuntimeStateError(`Refusing to write ${name} while existing state is unreadable`, {
        code: 'RUNTIME_STATE_WRITE_BLOCKED',
        file: targetFile,
        cause,
      });
    }
    if (cause?.name === 'SplitwiseMirrorResolutionError') {
      throw new RuntimeStateError(`Refusing to write ${name} while existing state is unreadable`, {
        code: 'RUNTIME_STATE_WRITE_BLOCKED',
        file: targetFile,
        cause,
      });
    }
    throw cause;
  }
}

function writeRuntimeState(name, value, {
  env = process.env,
  file,
  writeJson = writeJsonFile,
  enforceOwnership = true,
  semantic = true,
} = {}) {
  const { definition, schema, file: targetFile } = resolveTarget(name, env, file);
  if (definition.durability === 'passkey-server-writer') {
    throw new RuntimeStateError(
      `${name} is owned by the passkey server writer contract; use server.js persistence APIs`,
      { code: 'RUNTIME_STATE_DURABILITY_CONTRACT', file: targetFile },
    );
  }

  assertWritable(targetFile);
  let normalized;
  let previous = null;
  try {
    const input = cloneJson(value);
    const migrated = schema.migrate(input);
    normalized = schema.assertWritable(migrated.value);
    enforceUnknownFieldPolicy(name, input, normalized, schema);
    normalizeSagaTerminalEvidence(name, normalized);
    validateCallerInvariant(name, normalized);
    if (fs.existsSync(targetFile)) {
      previous = readExistingForWriteGuard(name, targetFile, env);
    }
    validateStrictWrite(name, normalized, previous);
  } catch (cause) {
    throw new RuntimeStateError(cause.message, {
      code: cause.code || 'RUNTIME_STATE_WRITE_INVALID',
      file: targetFile,
      cause,
    });
  }

  if (enforceOwnership && fs.existsSync(targetFile)) {
    try {
      if (previous == null) previous = readExistingForWriteGuard(name, targetFile, env);
      assertWriteGuards(name, previous, normalized);
    } catch (cause) {
      if (cause instanceof RuntimeStateError) throw cause;
      throw new RuntimeStateError(cause.message, {
        code: 'RUNTIME_STATE_OWNERSHIP_WEAKENED',
        file: targetFile,
        cause,
      });
    }
  }

  writeJson(targetFile, normalized);
  writeGuards.delete(targetFile);
  return normalized;
}

function readRuntimeStateByPath(targetPath, options = {}) {
  const name = registryNameForPath(targetPath, options.env);
  if (!name) {
    return {
      value: readJsonFile(targetPath, options.fallback, options.validate),
      meta: { source: 'unmanaged', file: targetPath },
    };
  }
  return readRuntimeState(name, { ...options, file: targetPath });
}

function writeRuntimeStateByPath(targetPath, value, options = {}) {
  const name = registryNameForPath(targetPath, options.env);
  if (!name) {
    assertWritable(targetPath);
    writeJsonFile(targetPath, value);
    return value;
  }
  return writeRuntimeState(name, value, { ...options, file: targetPath });
}

function validateBackupSidecar(filename, value) {
  const name = filenameToRegistryKey(filename);
  if (!name) throw new Error(`unsupported backup sidecar: ${filename}`);
  const schema = schemaForRegistryEntry(name);
  let migrated;
  try {
    migrated = schema.migrate(value);
  } catch (cause) {
    throw new Error(`${filename} migration failed: ${cause.message}`);
  }
  if (!schema.validateCurrent(migrated.value)) {
    throw new Error(`${filename} failed schema validation`);
  }
  enforceUnknownFieldPolicy(name, value, migrated.value, schema);
  validateCallerInvariant(name, migrated.value);
  if (semanticValidator(name)) {
    validateSemantic(name, migrated.value, { mode: 'read' });
  }
  return migrated.value;
}

function createRuntimeStateAccessors(name, { env = process.env, file, readJson, writeJson } = {}) {
  return {
    read: () => readRuntimeState(name, { env, file, readJson }).value,
    write: (value) => writeRuntimeState(name, value, { env, file, writeJson }),
    readDetailed: () => readRuntimeState(name, { env, file, readJson }),
  };
}

module.exports = {
  RuntimeStateError,
  SEMANTIC_STORES,
  assertWritable,
  createRuntimeStateAccessors,
  filenameToRegistryKey,
  lastGoodPath,
  markWriteGuard,
  readRuntimeState,
  readRuntimeStateByPath,
  registryNameForPath,
  resetWriteGuards,
  validateBackupSidecar,
  writeRuntimeState,
  writeRuntimeStateByPath,
};

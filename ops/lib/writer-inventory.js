'use strict';

const fs = require('fs');
const path = require('path');

const INVENTORY_PATH = path.join(__dirname, 'writer-inventory.json');
const INVENTORY_KIND = 'darkfinances-writer-inventory';
const SAFE_UNIT_PATTERN = /^[A-Za-z0-9@._-]+$/;
const SAFE_CONTAINER_PATTERN = /^[A-Za-z0-9_.-]+$/;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function loadWriterInventory(options = {}) {
  const inventoryPath = options.inventoryPath || INVENTORY_PATH;
  const stat = fs.lstatSync(inventoryPath);
  if (stat.isSymbolicLink()) throw new Error('writer inventory must not be a symbolic link');
  if (!stat.isFile()) throw new Error('writer inventory must be a regular file');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  } catch (error) {
    throw new Error(`writer inventory is not valid JSON: ${error.message}`);
  }
  if (!isPlainObject(parsed)) throw new Error('writer inventory must be a JSON object');
  if (parsed.kind !== INVENTORY_KIND) throw new Error('writer inventory kind mismatch');
  if (parsed.schemaVersion !== 1) {
    throw new Error(`unsupported writer inventory schemaVersion ${parsed.schemaVersion}`);
  }
  if (!Array.isArray(parsed.writers) || parsed.writers.length === 0) {
    throw new Error('writer inventory requires writers');
  }
  if (!Array.isArray(parsed.stopPhases) || parsed.stopPhases.length === 0) {
    throw new Error('writer inventory requires stopPhases');
  }
  if (!Array.isArray(parsed.restartPhases) || parsed.restartPhases.length === 0) {
    throw new Error('writer inventory requires restartPhases');
  }
  const ids = new Set();
  for (const writer of parsed.writers) {
    if (!isPlainObject(writer)) throw new Error('writer entry must be an object');
    if (typeof writer.id !== 'string' || !writer.id) {
      throw new Error('writer entry requires id');
    }
    if (ids.has(writer.id)) throw new Error(`duplicate writer id: ${writer.id}`);
    ids.add(writer.id);
    if (typeof writer.type !== 'string' || !writer.type) {
      throw new Error(`writer ${writer.id} requires type`);
    }
    if (typeof writer.stopPhase !== 'string' || !parsed.stopPhases.includes(writer.stopPhase)) {
      throw new Error(`writer ${writer.id} stopPhase is invalid`);
    }
    if (typeof writer.restartPhase !== 'string' || !parsed.restartPhases.includes(writer.restartPhase)) {
      throw new Error(`writer ${writer.id} restartPhase is invalid`);
    }
    if (!Array.isArray(writer.quiescentStates) || writer.quiescentStates.length === 0) {
      throw new Error(`writer ${writer.id} requires quiescentStates`);
    }
    if (writer.type === 'systemd-timer' || writer.type === 'systemd-service') {
      if (typeof writer.unit !== 'string' || !SAFE_UNIT_PATTERN.test(writer.unit)) {
        throw new Error(`writer ${writer.id} unit is unsafe or missing`);
      }
      if (writer.scope !== 'user' && writer.scope !== 'system') {
        throw new Error(`writer ${writer.id} scope must be user or system`);
      }
    }
    if (writer.type === 'docker-container') {
      if (typeof writer.containerName !== 'string' || !SAFE_CONTAINER_PATTERN.test(writer.containerName)) {
        throw new Error(`writer ${writer.id} containerName is unsafe or missing`);
      }
    }
  }
  return parsed;
}

function writerConfigured(writer, env = process.env) {
  if (writer.configEnv && env[writer.configEnv] !== '1') return false;
  if (writer.requireWhenEnv && env[writer.requireWhenEnv] !== '1') return false;
  return true;
}

function enumerateWriters(inventory, env = process.env) {
  const writers = [];
  for (const writer of inventory.writers) {
    if (!writerConfigured(writer, env)) {
      if (writer.optional === true) continue;
      if (writer.requireWhenEnv) continue;
      writers.push({ ...writer, configured: true });
      continue;
    }
    writers.push({ ...writer, configured: true });
  }
  return writers;
}

function writersForPhase(writers, phaseKey, phaseValue) {
  return writers.filter((writer) => writer[phaseKey] === phaseValue);
}

function writerInventoryDigest(inventory) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(`${JSON.stringify({
    schemaVersion: inventory.schemaVersion,
    kind: inventory.kind,
    stopPhases: inventory.stopPhases,
    restartPhases: inventory.restartPhases,
    writers: inventory.writers,
  })}\n`).digest('hex');
}

module.exports = {
  INVENTORY_KIND,
  INVENTORY_PATH,
  SAFE_UNIT_PATTERN,
  loadWriterInventory,
  writerInventoryDigest,
  writerConfigured,
  enumerateWriters,
  writersForPhase,
};

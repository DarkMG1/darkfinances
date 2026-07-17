'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { writeFileAtomic } = require('./restore-durable-io');
const { inventoryDigest, loadBackupStateInventory } = require('./backup-bundle-inventory');
const { loadWriterInventory } = require('./writer-inventory');

const JOURNAL_KIND = 'darkfinances-coordinated-run-journal';
const JOURNAL_SCHEMA_VERSION = 1;
const JOURNAL_MAX_BYTES = 512 * 1024;

const PHASE = Object.freeze({
  INIT: 'init',
  WRITERS_CAPTURED: 'writers_captured',
  QUIESCENCE_VERIFIED: 'quiescence_verified',
  BACKUP_COMPLETE: 'backup_complete',
  RESTART_COMPLETE: 'restart_complete',
  HEALTH_VERIFIED: 'health_verified',
  COMPLETE: 'complete',
  FAILED: 'failed',
  RECOVERY_REQUIRED: 'recovery_required',
});

function journalDigest(payload) {
  return crypto.createHash('sha256').update(`${JSON.stringify(payload)}\n`).digest('hex');
}

function createRunJournal({
  runId,
  operation,
  layout,
  inventory,
  writerInventory,
  preRunWriters,
  options = {},
}) {
  const runtimeInventory = inventory || loadBackupStateInventory();
  const writers = writerInventory || loadWriterInventory();
  const payload = {
    kind: JOURNAL_KIND,
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    runId,
    operation,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: PHASE.INIT,
    canonicalRoot: layout.canonicalRoot,
    inventory: {
      writerInventoryDigest: journalDigest({
        schemaVersion: writers.schemaVersion,
        kind: writers.kind,
        writers: writers.writers.map((entry) => entry.id),
      }),
      runtimeInventoryDigest: inventoryDigest(runtimeInventory),
    },
    preRunWriters,
    options: {
      includeActualData: options.includeActualData === true,
      quiesce: options.quiesce !== false,
      dashboardDir: options.dashboardDir || null,
    },
    artifacts: {},
    restartResults: [],
    healthResults: [],
    errors: [],
  };
  payload.journalId = journalDigest({
    runId,
    operation,
    createdAt: payload.createdAt,
    preRunWriters,
  });
  return payload;
}

function readRunJournal(journalPath) {
  if (!fs.existsSync(journalPath)) return null;
  const stat = fs.lstatSync(journalPath);
  if (stat.isSymbolicLink()) throw new Error('coordinated run journal must not be a symbolic link');
  if (!stat.isFile()) throw new Error('coordinated run journal must be a regular file');
  if (stat.size > JOURNAL_MAX_BYTES) throw new Error('coordinated run journal exceeds size limit');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  } catch (error) {
    throw new Error(`coordinated run journal is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('coordinated run journal must be a JSON object');
  }
  if (parsed.kind !== JOURNAL_KIND) throw new Error('coordinated run journal kind mismatch');
  if (parsed.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    throw new Error(`unsupported coordinated run journal schemaVersion ${parsed.schemaVersion}`);
  }
  return parsed;
}

function writeRunJournal(journalPath, journal) {
  const payload = {
    ...journal,
    updatedAt: new Date().toISOString(),
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > JOURNAL_MAX_BYTES) {
    throw new Error('coordinated run journal exceeds size limit');
  }
  writeFileAtomic(journalPath, text, 0o600);
  return payload;
}

function appendJournalError(journal, message) {
  journal.errors.push({
    at: new Date().toISOString(),
    message: String(message),
  });
  return journal;
}

function isTerminalPhase(phase) {
  return phase === PHASE.COMPLETE
    || phase === PHASE.FAILED
    || phase === PHASE.RECOVERY_REQUIRED;
}

function resumePhase(journal) {
  if (!journal || isTerminalPhase(journal.phase)) return null;
  return journal.phase;
}

module.exports = {
  JOURNAL_KIND,
  JOURNAL_SCHEMA_VERSION,
  JOURNAL_MAX_BYTES,
  PHASE,
  createRunJournal,
  readRunJournal,
  writeRunJournal,
  appendJournalError,
  isTerminalPhase,
  resumePhase,
  journalDigest,
};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { validateBackupSidecar } = require('../../finance-dashboard/lib/runtime-state-store');

const ROOT = path.resolve(__dirname, '..', '..');
const STATE_SCHEMA_VERSION = 1;

const SIDECAR_FILES = [
  'account-overrides.json',
  'bills-paid.json',
  'budget-settings.json',
  'debt-planner.json',
  'events.json',
  'goals.json',
  'investment-holdings.json',
  'manual-assets.json',
  'operation-journal.json',
  'owes-config.json',
  'owes-truth.json',
  'passkey-credentials.json',
  'personal-config.json',
  'phantom-log.json',
  'phantom-seen.json',
  'receipts.json',
  'reimb-links.json',
  'reimb-suggest.json',
  'reconciliation.json',
  'recurring-overrides.json',
  'review-state.json',
  'rules.json',
  'transaction-deletion-sagas.json',
  'bulk-operation-sagas.json',
  'splitwise-mirror-resolutions.json',
  'repayment-confirmation-sagas.json',
  'transaction-sagas.json',
  'venmo-truth.json',
];

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function gitCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function parseJson(label, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function assertArray(label, value) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
}

function assertObject(label, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function receiptRecords(receipts) {
  if (Array.isArray(receipts)) {
    for (const receipt of receipts) assertObject('receipts.json entry', receipt);
    return { format: 'legacy', records: receipts };
  }

  assertObject('receipts.json', receipts);
  assertObject('receipts.json byTxn', receipts.byTxn);
  const records = [];
  for (const [txnId, bucket] of Object.entries(receipts.byTxn)) {
    assertArray(`receipts.json byTxn.${txnId}`, bucket);
    for (const receipt of bucket) {
      assertObject(`receipts.json byTxn.${txnId} entry`, receipt);
      records.push(receipt);
    }
  }
  return { format: 'byTxn', records };
}

function validateSidecar(name, text) {
  const data = parseJson(name, text);
  return validateBackupSidecar(name, data);
}

function assertArchivedFile(root, relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`unsafe receipt path: ${relativePath}`);
  }
  if (!fs.existsSync(resolved) || !fs.lstatSync(resolved).isFile()) {
    throw new Error(`missing receipt file: ${relativePath}`);
  }
}

function validateReceiptReferences(receipts, dashboardDir) {
  const { format, records } = receiptRecords(receipts);
  for (const receipt of records) {
    if (format === 'legacy' && receipt.path != null) {
      assertArchivedFile(dashboardDir, receipt.path, 'receipt path');
    }
    if (format === 'byTxn' && receipt.file != null) {
      if (typeof receipt.file !== 'string' || path.basename(receipt.file) !== receipt.file) {
        throw new Error(`unsafe receipt path: ${receipt.file}`);
      }
      assertArchivedFile(path.join(dashboardDir, 'receipts'), receipt.file, 'receipt file');
    }
  }
}

function buildManifest({ dashboardDir, archivePath, files }) {
  const entries = files.map((name) => {
    const full = path.join(dashboardDir, name);
    const stat = fs.statSync(full);
    const entry = {
      path: name,
      sha256: stat.isDirectory() ? null : sha256File(full),
      bytes: stat.isDirectory() ? null : stat.size,
      mode: stat.mode & 0o777,
    };
    if (stat.isDirectory()) {
      entry.files = fs.readdirSync(full).sort().map((child) => {
        const childPath = path.join(full, child);
        const childStat = fs.statSync(childPath);
        return {
          path: `${name}/${child}`,
          sha256: sha256File(childPath),
          bytes: childStat.size,
          mode: childStat.mode & 0o777,
        };
      });
    }
    return entry;
  });

  return {
    kind: 'darkfinances-dashboard-runtime-backup',
    schemaVersion: STATE_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    repositoryCommit: gitCommit(),
    archive: path.basename(archivePath),
    files: entries,
    sidecars: SIDECAR_FILES.filter((name) => files.includes(name)),
    recovery: {
      requiresServiceStop: true,
      confirmEnv: 'CONFIRM=1',
      postRestoreChecks: [
        '/api/v1/ping',
        'browser passkey login',
        'receipts and reimbursements',
      ],
    },
  };
}

function verifyArchive({ archivePath, dashboardDir = null, requireCommit = false }) {
  if (!archivePath || !fs.existsSync(archivePath)) {
    throw new Error(`archive not found: ${archivePath}`);
  }

  const manifestPath = `${archivePath}.manifest.json`;
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`missing sidecar manifest: ${manifestPath}`);
  }

  const manifest = parseJson('manifest', fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.kind !== 'darkfinances-dashboard-runtime-backup') {
    throw new Error('manifest kind mismatch');
  }
  if (manifest.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(`unsupported manifest schemaVersion ${manifest.schemaVersion}`);
  }
  if (requireCommit && !manifest.repositoryCommit) {
    throw new Error('manifest is missing repositoryCommit');
  }

  const checksumPath = `${archivePath}.sha256`;
  if (fs.existsSync(checksumPath)) {
    const expected = fs.readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0];
    const actual = sha256File(archivePath);
    if (expected !== actual) throw new Error('archive checksum mismatch');
  }

  const listing = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
  if (listing.status !== 0) throw new Error(listing.stderr || 'tar listing failed');
  const members = new Set(listing.stdout.trim().split('\n').filter(Boolean));
  if (!members.has('.backup-manifest.json')) {
    throw new Error('archive is missing embedded .backup-manifest.json');
  }

  const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'darkfinances-verify-'));
  try {
    const embedded = spawnSync('tar', ['-xOf', archivePath, '.backup-manifest.json'], { encoding: 'utf8' });
    if (embedded.status !== 0) throw new Error('unable to read embedded manifest');
    const embeddedManifest = parseJson('.backup-manifest.json', embedded.stdout);
    if (embeddedManifest.archive !== manifest.archive) {
      throw new Error('embedded manifest archive name mismatch');
    }

    const extract = spawnSync('tar', ['-xzf', archivePath, '-C', tempDir], { encoding: 'utf8' });
    if (extract.status !== 0) throw new Error(extract.stderr || 'tar extract failed');

    for (const entry of manifest.files) {
      const target = path.join(tempDir, entry.path);
      if (!fs.existsSync(target)) throw new Error(`archive missing ${entry.path}`);
      if (entry.sha256) {
        const actual = sha256File(target);
        if (actual !== entry.sha256) throw new Error(`checksum mismatch for ${entry.path}`);
      }
      if (entry.files) {
        for (const child of entry.files) {
          const childTarget = path.join(tempDir, child.path);
          if (!fs.existsSync(childTarget)) throw new Error(`archive missing ${child.path}`);
          if (sha256File(childTarget) !== child.sha256) {
            throw new Error(`checksum mismatch for ${child.path}`);
          }
        }
      }
      if (entry.path.endsWith('.json')) {
        validateSidecar(entry.path, fs.readFileSync(target, 'utf8'));
      }
    }

    const receiptsPath = path.join(tempDir, 'receipts.json');
    if (fs.existsSync(receiptsPath)) {
      const receipts = validateSidecar('receipts.json', fs.readFileSync(receiptsPath, 'utf8'));
      validateReceiptReferences(receipts, tempDir);
    }

    if (dashboardDir) {
      for (const entry of manifest.files) {
        if (!entry.path.endsWith('.json')) continue;
        const live = path.join(dashboardDir, entry.path);
        if (!fs.existsSync(live)) continue;
        validateSidecar(entry.path, fs.readFileSync(live, 'utf8'));
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return manifest;
}

module.exports = {
  SIDECAR_FILES,
  STATE_SCHEMA_VERSION,
  buildManifest,
  validateSidecar,
  validateReceiptReferences,
  verifyArchive,
  sha256File,
};

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  isTerminalSagaForFamily,
} = require('../../finance-dashboard/lib/runtime-state-semantics');
const {
  isCompleted,
  isKnownFailed,
} = require('../../finance-dashboard/lib/operation-journal');
const { runtimeArtifactId, runtimeEntriesFromManifest } = require('./backup-bundle-manifest');
const {
  inventoryDigest,
  loadBackupStateInventory,
  isExcludedRuntimeBasename,
  lastGoodRelativePath,
  allowsLastGoodSidecar,
} = require('./backup-bundle-inventory');
const {
  BINDING_FIELD,
  ACTIVE_SAGA_STORES,
  runtimeEntriesFromRoot,
  generationBindingArtifactId,
} = require('./generation-binding-artifact');

const BINDING_SCHEMA_VERSION = 1;

function assertSupportedBindingSchemaVersion(version) {
  if (version !== BINDING_SCHEMA_VERSION) {
    throw new Error(`unsupported restore generation binding schemaVersion ${version}`);
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function canonicalBinding(binding) {
  return JSON.stringify({
    schemaVersion: binding.schemaVersion,
    dashboardStateId: binding.dashboardStateId,
    backupArtifactId: binding.backupArtifactId,
    releaseManifestDigest: binding.releaseManifestDigest ?? null,
    sourceCommit: binding.sourceCommit ?? null,
    actualDataGeneration: binding.actualDataGeneration ?? null,
    inventoryDigest: binding.inventoryDigest ?? null,
  });
}

function bindingDigest(binding) {
  return crypto.createHash('sha256').update(`${canonicalBinding(binding)}\n`).digest('hex');
}

function bindingsEquivalent(left, right) {
  if (!left || !right) return false;
  return bindingDigest(left) === bindingDigest(right);
}

function validateBindingShape(binding, label = 'generationBinding') {
  if (!isPlainObject(binding)) throw new Error(`${label} must be an object`);
  assertSupportedBindingSchemaVersion(binding.schemaVersion);
  for (const field of [
    'dashboardStateId',
    'backupArtifactId',
    'releaseManifestDigest',
    'sourceCommit',
    'actualDataGeneration',
    'inventoryDigest',
  ]) {
    const value = binding[field];
    if (value == null) continue;
    if (typeof value !== 'string' || !value) {
      throw new Error(`${label}.${field} must be a non-empty string when present`);
    }
  }
  if (typeof binding.dashboardStateId !== 'string' || !/^[a-f0-9]{64}$/.test(binding.dashboardStateId)) {
    throw new Error(`${label}.dashboardStateId must be a sha256 hex digest`);
  }
  if (typeof binding.backupArtifactId !== 'string' || !/^[a-f0-9]{64}$/.test(binding.backupArtifactId)) {
    throw new Error(`${label}.backupArtifactId must be a sha256 hex digest`);
  }
  return binding;
}

function storeDefinition(inventory, storeName) {
  const store = inventory.stores.find((entry) => entry.name === storeName);
  if (!store) throw new Error(`unknown runtime store: ${storeName}`);
  return store;
}

function writeActiveSubjectStore(runtimeRoot, inventory, subject, record) {
  const store = storeDefinition(inventory, subject.store);
  const filePath = path.join(runtimeRoot, store.filename);
  const payload = readJsonIfExists(filePath);
  if (!payload) throw new Error(`missing store while embedding generation binding: ${store.filename}`);
  if (subject.store === 'operationJournal') {
    payload.operations[subject.id] = record;
  } else {
    payload.sagas[subject.id] = record;
  }
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function embedActiveGenerationBindingsForBuild({
  runtimeRoot,
  inventory,
  provenance = {},
}) {
  const runtimeEntries = runtimeEntriesFromRoot(runtimeRoot, inventory);
  const generationId = generationBindingArtifactId({ runtimeRoot, runtimeEntries, inventory });
  const binding = buildGenerationBinding({
    files: runtimeEntries,
    provenance: {
      sourceCommit: provenance.sourceCommit ?? null,
      releaseManifestDigest: provenance.releaseManifestDigest ?? null,
      actualDataGeneration: provenance.actualDataGeneration ?? null,
    },
    runtimeState: {
      inventoryDigest: inventoryDigest(inventory),
    },
    artifact: { id: generationId },
  }, provenance, { runtimeRoot, inventory });
  const subjects = scanActiveRestoreSubjects(runtimeRoot, { inventory });
  for (const subject of subjects) {
    const current = recordBinding(subject.record);
    if (bindingsEquivalent(current, binding)) continue;
    subject.record[BINDING_FIELD] = binding;
    writeActiveSubjectStore(runtimeRoot, inventory, subject, subject.record);
  }
  return binding;
}

function buildGenerationBinding(manifest, options = {}, runtimeContext = null) {
  const runtimeEntries = runtimeEntriesFromManifest(manifest);
  const dashboardStateId = runtimeContext
    ? generationBindingArtifactId({
      runtimeRoot: runtimeContext.runtimeRoot,
      runtimeEntries,
      inventory: runtimeContext.inventory,
    })
    : (manifest.artifact?.id || runtimeArtifactId(runtimeEntries));
  const binding = {
    schemaVersion: BINDING_SCHEMA_VERSION,
    dashboardStateId,
    backupArtifactId: manifest.artifact?.id || dashboardStateId,
    releaseManifestDigest: options.releaseManifestDigest
      ?? manifest.provenance?.releaseManifestDigest
      ?? null,
    sourceCommit: options.sourceCommit ?? manifest.provenance?.sourceCommit ?? null,
    actualDataGeneration: options.actualDataGeneration
      ?? manifest.provenance?.actualDataGeneration
      ?? null,
    inventoryDigest: manifest.runtimeState?.inventoryDigest ?? null,
  };
  if (binding.backupArtifactId !== dashboardStateId) {
    throw new Error('manifest artifact.id must match runtime generation digest');
  }
  return validateBindingShape(binding);
}

function extractBindingFromManifest(manifest) {
  if (!manifest?.generationBinding) {
    throw new Error('bundle manifest is missing generationBinding');
  }
  const binding = validateBindingShape(manifest.generationBinding, 'manifest.generationBinding');
  const artifactId = manifest.artifact?.id;
  if (!artifactId) throw new Error('manifest.artifact.id is required');
  if (binding.dashboardStateId !== artifactId || binding.backupArtifactId !== artifactId) {
    throw new Error('manifest generationBinding does not match runtime artifact identity');
  }
  if (binding.inventoryDigest && manifest.runtimeState?.inventoryDigest
    && binding.inventoryDigest !== manifest.runtimeState.inventoryDigest) {
    throw new Error('manifest generationBinding inventoryDigest mismatch');
  }
  return binding;
}

function isTerminalOperation(operation) {
  return isCompleted(operation) || isKnownFailed(operation);
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function activeJournalEntries(journal) {
  const active = [];
  if (!journal?.operations) return active;
  for (const [key, operation] of Object.entries(journal.operations)) {
    if (!isTerminalOperation(operation)) {
      active.push({ store: 'operationJournal', id: key, record: operation });
    }
  }
  return active;
}

function activeSagaEntries(storeName, store) {
  const active = [];
  if (!store?.sagas) return active;
  for (const [id, saga] of Object.entries(store.sagas)) {
    if (!saga || isTerminalSagaForFamily(storeName, saga)) continue;
    active.push({ store: storeName, id, record: saga });
  }
  return active;
}

function scanActiveRestoreSubjects(runtimeRoot, options = {}) {
  const inventory = options.inventory || loadBackupStateInventory(options);
  const subjects = [];
  for (const store of inventory.stores) {
    if (!ACTIVE_SAGA_STORES.includes(store.name)) continue;
    const filePath = path.join(runtimeRoot, store.filename);
    const payload = readJsonIfExists(filePath);
    if (!payload) continue;
    if (store.name === 'operationJournal') {
      subjects.push(...activeJournalEntries(payload));
      continue;
    }
    subjects.push(...activeSagaEntries(store.name, payload));
  }
  return subjects;
}

function recordBinding(record) {
  if (!record || !isPlainObject(record[BINDING_FIELD])) return null;
  try {
    return validateBindingShape(record[BINDING_FIELD], BINDING_FIELD);
  } catch {
    return null;
  }
}

function validateActiveSubjectBindings(subjects, expectedBinding) {
  const legacyActive = [];
  const mismatched = [];
  for (const subject of subjects) {
    const binding = recordBinding(subject.record);
    if (!binding) {
      legacyActive.push(subject);
      continue;
    }
    if (!bindingsEquivalent(binding, expectedBinding)) {
      mismatched.push({ ...subject, binding });
    }
  }
  if (legacyActive.length > 0) {
    const ids = legacyActive.map((entry) => `${entry.store}:${entry.id}`).join(', ');
    throw new Error(`active restore subjects lack ${BINDING_FIELD}; refusing legacy guess: ${ids}`);
  }
  if (mismatched.length > 0) {
    const ids = mismatched.map((entry) => `${entry.store}:${entry.id}`).join(', ');
    throw new Error(`active restore subject generation binding mismatch: ${ids}`);
  }
}

function readDestinationGenerationEvidence(options = {}) {
  const releaseManifestPath = options.releaseManifestPath || null;
  const actualGenerationPath = options.actualDataGenerationPath || null;
  let releaseManifestDigest = options.releaseManifestDigest ?? null;
  let actualDataGeneration = options.actualDataGeneration ?? null;

  if (releaseManifestPath && fs.existsSync(releaseManifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(releaseManifestPath, 'utf8'));
    releaseManifestDigest = manifest.contentDigest
      || manifest.content?.contentDigest
      || manifest.digest
      || releaseManifestDigest;
  }
  if (actualGenerationPath && fs.existsSync(actualGenerationPath)) {
    actualDataGeneration = fs.readFileSync(actualGenerationPath, 'utf8').trim().split(/\s+/)[0]
      || actualDataGeneration;
  }
  return { releaseManifestDigest, actualDataGeneration };
}

function validateDestinationGenerationCompatibility(expectedBinding, destinationEvidence) {
  if (expectedBinding.releaseManifestDigest && destinationEvidence.releaseManifestDigest
    && expectedBinding.releaseManifestDigest !== destinationEvidence.releaseManifestDigest) {
    throw new Error('destination release generation does not match bundle binding');
  }
  if (expectedBinding.actualDataGeneration && destinationEvidence.actualDataGeneration
    && expectedBinding.actualDataGeneration !== destinationEvidence.actualDataGeneration) {
    throw new Error('destination Actual data generation does not match bundle binding');
  }
}

function validateGenerationBindingForRestore({
  manifest,
  runtimeRoot,
  inventory,
  destinationEvidence = {},
}) {
  const expectedBinding = extractBindingFromManifest(manifest);
  const subjects = scanActiveRestoreSubjects(runtimeRoot, { inventory });
  validateActiveSubjectBindings(subjects, expectedBinding);
  validateDestinationGenerationCompatibility(expectedBinding, destinationEvidence);
  return { expectedBinding, activeSubjects: subjects };
}

function managedRuntimeRelativePaths(inventory, manifestRuntimePaths) {
  const managed = new Set(manifestRuntimePaths);
  for (const store of inventory.stores) {
    managed.add(store.filename);
    if (allowsLastGoodSidecar(store)) {
      managed.add(lastGoodRelativePath(store.filename));
    }
  }
  managed.add(inventory.auxiliary.receiptsDirectory);
  return managed;
}

function listDestinationRuntimeFiles(destinationRoot, inventory) {
  const files = [];
  if (!fs.existsSync(destinationRoot)) return files;

  function walkDir(relativeDir) {
    const absoluteDir = relativeDir
      ? path.join(destinationRoot, relativeDir)
      : destinationRoot;
    if (!fs.existsSync(absoluteDir)) return;
    for (const name of fs.readdirSync(absoluteDir).sort()) {
      const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
      if (relativePath.startsWith('.restore-work-')) continue;
      if (isExcludedRuntimeBasename(name)) continue;
      if (name === '.env' || name.startsWith('.env.')) continue;
      if (name === '.restore-journal.json') continue;
      const absolutePath = path.join(destinationRoot, relativePath);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`destination symbolic link forbidden: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        walkDir(relativePath);
        continue;
      }
      if (stat.isFile()) files.push(relativePath.replace(/\\/g, '/'));
    }
  }

  walkDir('');
  return [...new Set(files)].sort();
}

function classifyDestinationExtras(destinationFiles, manifestRelativePaths, inventory) {
  const expected = new Set(manifestRelativePaths);
  const managedBasenames = new Set(inventory.stores.map((store) => store.filename));
  const staleOnly = [];
  const unknown = [];
  for (const relativePath of destinationFiles) {
    if (expected.has(relativePath)) continue;
    const basename = path.basename(relativePath);
    if (isExcludedRuntimeBasename(basename)) continue;
    if (/\.corrupt-/.test(relativePath)) continue;
    if (basename === '.env' || basename.startsWith('.env.')) continue;
    if (relativePath.endsWith('.restore-journal.json')) continue;
    const isManaged = managedBasenames.has(basename)
      || relativePath.endsWith('.last-good')
      || relativePath.startsWith(`${inventory.auxiliary.receiptsDirectory}/`)
      || relativePath === inventory.auxiliary.receiptsDirectory;
    if (isManaged) staleOnly.push(relativePath);
    else unknown.push(relativePath);
  }
  return { staleOnly, unknown };
}

module.exports = {
  BINDING_SCHEMA_VERSION,
  BINDING_FIELD,
  ACTIVE_SAGA_STORES,
  assertSupportedBindingSchemaVersion,
  buildGenerationBinding,
  extractBindingFromManifest,
  bindingsEquivalent,
  validateBindingShape,
  scanActiveRestoreSubjects,
  validateActiveSubjectBindings,
  validateDestinationGenerationCompatibility,
  validateGenerationBindingForRestore,
  readDestinationGenerationEvidence,
  managedRuntimeRelativePaths,
  listDestinationRuntimeFiles,
  classifyDestinationExtras,
  bindingDigest,
  runtimeEntriesFromRoot,
  embedActiveGenerationBindingsForBuild,
  generationBindingArtifactId,
};

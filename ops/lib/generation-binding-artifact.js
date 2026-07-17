'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { RUNTIME_PREFIX } = require('./backup-bundle-schema');
const { sha256File } = require('./backup-verify');
const {
  isExcludedRuntimeBasename,
  lastGoodRelativePath,
  allowsLastGoodSidecar,
} = require('./backup-bundle-inventory');

const BINDING_FIELD = 'restoreGenerationBinding';

const ACTIVE_SAGA_STORES = Object.freeze([
  'operationJournal',
  'transactionSagas',
  'transactionDeletionSagas',
  'repaymentConfirmationSagas',
  'bulkOperationSagas',
]);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stripBindingFromStorePayload(storeName, payload) {
  if (!payload || !isPlainObject(payload)) return payload;
  if (storeName === 'operationJournal') {
    const operations = {};
    for (const [key, operation] of Object.entries(payload.operations || {})) {
      if (!isPlainObject(operation)) {
        operations[key] = operation;
        continue;
      }
      const { [BINDING_FIELD]: _removed, ...rest } = operation;
      operations[key] = rest;
    }
    return { ...payload, operations };
  }
  if (isPlainObject(payload.sagas)) {
    const sagas = {};
    for (const [key, saga] of Object.entries(payload.sagas)) {
      if (!isPlainObject(saga)) {
        sagas[key] = saga;
        continue;
      }
      const { [BINDING_FIELD]: _removed, ...rest } = saga;
      sagas[key] = rest;
    }
    return { ...payload, sagas };
  }
  return payload;
}

function storeNameForRuntimeRelative(relativePath, inventory) {
  const basename = path.basename(relativePath);
  const store = inventory.stores.find((entry) => entry.filename === basename
    || lastGoodRelativePath(entry.filename) === relativePath);
  return store?.name ?? null;
}

function generationContentDigest(relativePath, absolutePath, inventory) {
  const storeName = storeNameForRuntimeRelative(relativePath, inventory);
  if (storeName && ACTIVE_SAGA_STORES.includes(storeName)) {
    const payload = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    const stripped = stripBindingFromStorePayload(storeName, payload);
    return crypto.createHash('sha256').update(`${JSON.stringify(stripped)}\n`).digest('hex');
  }
  return sha256File(absolutePath);
}

function runtimeEntriesFromRoot(runtimeRoot, inventory) {
  const entries = [];
  const pushFile = (relativePath, absolutePath) => {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) throw new Error(`refusing symlink during binding embed: ${relativePath}`);
    if (!stat.isFile()) throw new Error(`expected file during binding embed: ${relativePath}`);
    entries.push({
      path: `${RUNTIME_PREFIX}${relativePath.replace(/\\/g, '/')}`,
      sha256: sha256File(absolutePath),
      bytes: stat.size,
      mode: stat.mode & 0o777,
    });
  };

  for (const store of inventory.stores) {
    const primary = path.join(runtimeRoot, store.filename);
    if (fs.existsSync(primary)) {
      pushFile(store.filename, primary);
      if (allowsLastGoodSidecar(store)) {
        const lastGoodRelative = lastGoodRelativePath(store.filename);
        const lastGood = path.join(runtimeRoot, lastGoodRelative);
        if (fs.existsSync(lastGood)) pushFile(lastGoodRelative, lastGood);
      }
    }
  }

  const receiptsDir = path.join(runtimeRoot, inventory.auxiliary.receiptsDirectory);
  if (fs.existsSync(receiptsDir)) {
    for (const child of fs.readdirSync(receiptsDir).sort()) {
      if (isExcludedRuntimeBasename(child)) continue;
      const absolute = path.join(receiptsDir, child);
      if (!fs.lstatSync(absolute).isFile()) continue;
      pushFile(`${inventory.auxiliary.receiptsDirectory}/${child}`, absolute);
    }
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function generationBindingArtifactId({ runtimeRoot, runtimeEntries, inventory }) {
  const hash = crypto.createHash('sha256');
  for (const entry of runtimeEntries) {
    const relative = entry.path.startsWith(RUNTIME_PREFIX)
      ? entry.path.slice(RUNTIME_PREFIX.length)
      : entry.path;
    const absolute = path.join(runtimeRoot, relative);
    hash.update(entry.path);
    hash.update(generationContentDigest(relative, absolute, inventory));
  }
  return hash.digest('hex');
}

module.exports = {
  BINDING_FIELD,
  ACTIVE_SAGA_STORES,
  stripBindingFromStorePayload,
  generationContentDigest,
  runtimeEntriesFromRoot,
  generationBindingArtifactId,
};

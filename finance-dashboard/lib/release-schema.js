const {
  normalizePublisherToolchain,
} = require('./publisher-toolchain');
const crypto = require('crypto');
const path = require('path');

const MANIFEST_KIND = 'darkfinances-release';
const MANIFEST_SCHEMA_VERSION = 2;
const CONTENT_DIGEST_ALGORITHM = 'sha256';
const CANONICALIZATION = 'darkfinances-canonical-json-v1';
const RELEASE_MODES = new Set(['source', 'dashboard', 'ipa', 'ota', 'backup']);
const RELEASE_VARIANTS = new Set(['full', 'free-sideload']);
const RELEASE_PROFILE_RULES = Object.freeze({
  production: Object.freeze({
    variant: 'full',
    branch: 'production',
    channel: 'production',
    environment: 'production',
  }),
  preview: Object.freeze({
    variant: 'full',
    branch: 'preview',
    channel: 'preview',
    environment: 'preview',
  }),
  'free-sideload': Object.freeze({
    variant: 'free-sideload',
    branch: 'free-sideload',
    channel: 'free-sideload',
    environment: 'production',
  }),
});
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ACTUAL_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
}

function assertNoUnknownKeys(value, allowed, label) {
  assertPlainObject(value, label);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalSerialize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON does not support non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalSerialize(entry)).join(',')}]`;
  }
  if (!isPlainObject(value)) {
    throw new Error(`canonical JSON does not support ${typeof value}`);
  }
  const entries = Object.keys(value).sort().map((key) => {
    if (value[key] === undefined) {
      throw new Error(`canonical JSON does not support undefined at ${key}`);
    }
    return `${JSON.stringify(key)}:${canonicalSerialize(value[key])}`;
  });
  return `{${entries.join(',')}}`;
}

function normalizeLogicalPath(value, label = 'path') {
  const original = requireNonEmptyString(value, label);
  const portable = original.replaceAll('\\', '/');
  if (portable.startsWith('/') || /^[A-Za-z]:\//.test(portable)) {
    throw new Error(`${label} must be relative: ${original}`);
  }
  const parts = portable.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`${label} is not a normalized relative path: ${original}`);
  }
  const normalized = path.posix.normalize(portable);
  if (normalized === '.' || normalized.startsWith('../')) {
    throw new Error(`${label} escapes its root: ${original}`);
  }
  return normalized;
}

function validateHash(value, label) {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

function validateFileEvidence(value, label) {
  assertNoUnknownKeys(value, new Set(['bytes', 'file', 'sha256']), label);
  requireNonEmptyString(value.file, `${label} filename`);
  if (
    path.basename(value.file) !== value.file
    || value.file.includes('/')
    || value.file.includes('\\')
    || value.file === '.'
    || value.file === '..'
  ) {
    throw new Error(`${label} filename must not expose a path`);
  }
  validateHash(value.sha256, `${label} hash`);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    throw new Error(`${label} bytes must be non-negative`);
  }
}

function requireVersion(value, label) {
  if (typeof value !== 'string' || !ACTUAL_VERSION_PATTERN.test(value)) {
    throw new Error(`${label} must be an exact x.y.z version`);
  }
  return value;
}

function validateActualAlignment(actual) {
  assertNoUnknownKeys(actual, new Set(['dashboardApi', 'serverImage', 'toolsApi']), 'Actual alignment');
  const serverImage = requireVersion(actual.serverImage, 'Actual server image version');
  const dashboardApi = requireVersion(actual.dashboardApi, 'finance-dashboard @actual-app/api');
  const toolsApi = requireVersion(actual.toolsApi, 'actual-tools @actual-app/api');
  if (dashboardApi !== toolsApi) {
    throw new Error(`@actual-app/api mismatch: dashboard=${dashboardApi}, actual-tools=${toolsApi}`);
  }
  if (serverImage !== dashboardApi) {
    throw new Error(`Actual API/server mismatch: server=${serverImage}, api=${dashboardApi}`);
  }
  return { serverImage, dashboardApi, toolsApi };
}

function normalizeOtaEvidence(value) {
  const allowed = new Set([
    'branch',
    'channel',
    'environment',
    'groupId',
    'profile',
    'runtimeVersion',
    'updateId',
    'updateIds',
    'updates',
  ]);
  assertNoUnknownKeys(value, allowed, 'OTA evidence');
  const updates = [];
  if (value.updateId !== undefined) {
    updates.push({ id: requireNonEmptyString(value.updateId, 'OTA update ID') });
  }
  if (value.updateIds !== undefined) {
    if (!Array.isArray(value.updateIds)) throw new Error('OTA updateIds must be an array');
    for (const id of value.updateIds) updates.push({ id: requireNonEmptyString(id, 'OTA update ID') });
  }
  if (value.updates !== undefined) {
    if (!Array.isArray(value.updates)) throw new Error('OTA updates must be an array');
    for (const update of value.updates) {
      assertNoUnknownKeys(update, new Set(['id', 'platform']), 'OTA update');
      updates.push({
        id: requireNonEmptyString(update.id, 'OTA update ID'),
        ...(update.platform === undefined
          ? {}
          : { platform: requireNonEmptyString(update.platform, 'OTA update platform') }),
      });
    }
  }
  updates.sort((left, right) => {
    const platform = compareStrings(left.platform || '', right.platform || '');
    return platform || compareStrings(left.id, right.id);
  });
  const updateKeys = updates.map((entry) => `${entry.platform || ''}\0${entry.id}`);
  if (new Set(updateKeys).size !== updateKeys.length) throw new Error('OTA update IDs must be unique');

  const groupId = value.groupId === undefined
    ? null
    : requireNonEmptyString(value.groupId, 'OTA group ID');
  if (!groupId && updates.length === 0) throw new Error('OTA evidence requires a group ID or update ID');
  return {
    ...(groupId ? { groupId } : {}),
    ...(updates.length > 0 ? { updates } : {}),
    runtimeVersion: requireNonEmptyString(value.runtimeVersion, 'OTA runtime version'),
    channel: requireNonEmptyString(value.channel, 'OTA channel'),
    branch: requireNonEmptyString(value.branch, 'OTA branch'),
    profile: requireNonEmptyString(value.profile, 'OTA release profile'),
    environment: requireNonEmptyString(value.environment, 'OTA environment'),
  };
}

function validateManifestContent(content) {
  assertNoUnknownKeys(content, new Set([
    'actual',
    'app',
    'artifact',
    'backup',
    'contract',
    'deployedFiles',
    'lockfile',
    'mode',
    'ota',
    'publisherToolchain',
    'repository',
    'sourceEvidence',
  ]), 'manifest content');
  if (!RELEASE_MODES.has(content.mode)) throw new Error(`unsupported release mode: ${content.mode}`);
  assertNoUnknownKeys(content.repository, new Set(['commit', 'dirty', 'source']), 'repository identity');
  if (!GIT_COMMIT_PATTERN.test(content.repository.commit)) throw new Error('repository commit is invalid');
  assertNoUnknownKeys(
    content.repository.source,
    new Set(['algorithm', 'digest', 'state', 'trackedDirty', 'untrackedSource']),
    'source identity',
  );
  if (
    typeof content.repository.dirty !== 'boolean'
    || typeof content.repository.source.trackedDirty !== 'boolean'
    || typeof content.repository.source.untrackedSource !== 'boolean'
  ) {
    throw new Error('repository dirty evidence must use booleans');
  }
  if (content.repository.dirty !== (content.repository.source.state !== 'clean')) {
    throw new Error('repository dirty state is inconsistent');
  }
  if (content.repository.source.algorithm !== CONTENT_DIGEST_ALGORITHM) {
    throw new Error('source digest algorithm must be sha256');
  }
  validateHash(content.repository.source.digest, 'source digest');
  const expectedState = content.repository.source.trackedDirty
    ? (content.repository.source.untrackedSource ? 'tracked-dirty-and-untracked-source' : 'tracked-dirty')
    : (content.repository.source.untrackedSource ? 'untracked-source' : 'clean');
  if (content.repository.source.state !== expectedState) throw new Error('source state evidence is inconsistent');

  assertNoUnknownKeys(content.lockfile, new Set(['path', 'sha256']), 'lockfile identity');
  if (content.lockfile.path !== 'package-lock.json') throw new Error('lockfile path must be package-lock.json');
  validateHash(content.lockfile.sha256, 'lockfile hash');
  validateActualAlignment(content.actual);
  assertNoUnknownKeys(content.contract, new Set(['fingerprint']), 'contract identity');
  if (!/^[a-f0-9]{16}$/.test(content.contract.fingerprint)) {
    throw new Error('contract fingerprint must be 16 lowercase hexadecimal characters');
  }
  assertNoUnknownKeys(
    content.app,
    new Set(['iosBuildNumber', 'releaseProfile', 'runtimeVersion', 'updateChannel', 'variant', 'version']),
    'app identity',
  );
  for (const key of ['variant', 'releaseProfile', 'version', 'runtimeVersion', 'updateChannel', 'iosBuildNumber']) {
    requireNonEmptyString(content.app[key], `app ${key}`);
  }
  if (!RELEASE_VARIANTS.has(content.app.variant)) {
    throw new Error(`unsupported app variant: ${content.app.variant}`);
  }
  const profileRule = RELEASE_PROFILE_RULES[content.app.releaseProfile];
  if (!profileRule) throw new Error(`unsupported release profile: ${content.app.releaseProfile}`);
  if (profileRule.variant !== content.app.variant) {
    throw new Error('release profile does not match app variant');
  }
  if (content.app.variant === 'free-sideload') {
    if (
      content.app.runtimeVersion !== `${content.app.version}-free-sideload`
      || content.app.updateChannel !== 'free-sideload'
    ) {
      throw new Error('free-sideload app identity must use its isolated runtime and update channel');
    }
  } else if (
    content.app.runtimeVersion.endsWith('-free-sideload')
    || content.app.updateChannel !== 'production'
  ) {
    throw new Error('full app identity must preserve the resolved production channel and full runtime');
  }

  if (content.deployedFiles !== undefined) {
    if (!Array.isArray(content.deployedFiles) || content.deployedFiles.length === 0) {
      throw new Error('deployedFiles must contain at least one file');
    }
    let previous = null;
    for (const entry of content.deployedFiles) {
      assertNoUnknownKeys(entry, new Set(['bytes', 'executable', 'path', 'sha256']), 'deployed file');
      const normalized = normalizeLogicalPath(entry.path, 'deployed file path');
      if (normalized !== entry.path) throw new Error(`deployed file path is not normalized: ${entry.path}`);
      if (previous !== null && compareStrings(previous, entry.path) >= 0) {
        throw new Error('deployed files must be uniquely sorted by path');
      }
      previous = entry.path;
      validateHash(entry.sha256, `deployed file ${entry.path} hash`);
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
        throw new Error(`deployed file ${entry.path} bytes must be non-negative`);
      }
      if (typeof entry.executable !== 'boolean') {
        throw new Error(`deployed file ${entry.path} executable must be a boolean`);
      }
    }
  }
  if (content.artifact !== undefined) validateFileEvidence(content.artifact, 'artifact evidence');
  if (content.backup !== undefined) {
    assertNoUnknownKeys(content.backup, new Set(['additionalArchives', 'archive', 'manifest']), 'backup evidence');
    validateFileEvidence(content.backup.manifest, 'backup manifest evidence');
    validateFileEvidence(content.backup.archive, 'backup archive evidence');
    if (content.backup.additionalArchives !== undefined) {
      if (!Array.isArray(content.backup.additionalArchives) || content.backup.additionalArchives.length === 0) {
        throw new Error('backup additionalArchives must contain at least one archive');
      }
      let previous = null;
      for (const archive of content.backup.additionalArchives) {
        validateFileEvidence(archive, 'additional backup archive evidence');
        if (previous !== null && compareStrings(previous, archive.file) >= 0) {
          throw new Error('additional backup archives must have unique sorted filenames');
        }
        previous = archive.file;
      }
    }
  }
  if (content.sourceEvidence !== undefined) {
    assertNoUnknownKeys(content.sourceEvidence, new Set(['archive', 'dirtyPatch']), 'source evidence');
    if (!content.sourceEvidence.archive && !content.sourceEvidence.dirtyPatch) {
      throw new Error('source evidence must include an archive or dirty patch');
    }
    if (content.sourceEvidence.archive) validateFileEvidence(content.sourceEvidence.archive, 'source archive evidence');
    if (content.sourceEvidence.dirtyPatch) validateFileEvidence(content.sourceEvidence.dirtyPatch, 'dirty patch evidence');
  }
  if (content.ota !== undefined) {
    const normalizedOta = normalizeOtaEvidence(content.ota);
    if (canonicalSerialize(normalizedOta) !== canonicalSerialize(content.ota)) {
      throw new Error('OTA evidence must use normalized sorted fields');
    }
    if (content.ota.runtimeVersion !== content.app.runtimeVersion) {
      throw new Error('OTA runtime does not match app runtime');
    }
    if (content.ota.channel !== profileRule.channel) {
      throw new Error('OTA channel does not match release profile');
    }
    if (content.ota.profile !== content.app.releaseProfile) {
      throw new Error('OTA profile does not match app release profile');
    }
    if (content.ota.branch !== profileRule.branch) {
      throw new Error('OTA branch does not match release profile');
    }
    if (content.ota.environment !== profileRule.environment) {
      throw new Error('OTA environment does not match release profile');
    }
  }
  if (content.publisherToolchain !== undefined) {
    const normalizedPublisher = normalizePublisherToolchain(content.publisherToolchain);
    if (canonicalSerialize(normalizedPublisher) !== canonicalSerialize(content.publisherToolchain)) {
      throw new Error('publisherToolchain must use normalized fields');
    }
  }

  const releaseEvidence = {
    dashboard: content.deployedFiles !== undefined,
    ipa: content.artifact !== undefined,
    ota: content.ota !== undefined,
    backup: content.backup !== undefined,
    publisherToolchain: content.publisherToolchain !== undefined,
  };
  const incompatibleEvidence = Object.entries(releaseEvidence)
    .filter(([evidenceMode, present]) => present && evidenceMode !== content.mode && evidenceMode !== 'publisherToolchain')
    .map(([evidenceMode]) => evidenceMode);
  if (incompatibleEvidence.length > 0) {
    throw new Error(`${content.mode} mode contains incompatible ${incompatibleEvidence.join(', ')} evidence`);
  }
  if (content.publisherToolchain !== undefined && content.mode !== 'ota') {
    throw new Error('publisherToolchain evidence is only valid for ota mode');
  }

  if (content.mode === 'dashboard' && !content.deployedFiles) {
    throw new Error('dashboard mode requires deployed file evidence');
  }
  if (content.mode === 'ipa' && !content.artifact) {
    throw new Error('ipa mode requires --artifact');
  }
  if (content.mode === 'ota' && !content.ota) {
    throw new Error('ota mode requires update/group ID, runtime, channel, and branch evidence');
  }
  if (content.mode === 'ota' && !content.publisherToolchain) {
    throw new Error('ota mode requires publisherToolchain evidence');
  }
  if (content.mode === 'backup' && !content.backup) {
    throw new Error('backup mode requires both backup manifest and archive evidence');
  }
  return true;
}

function calculateContentDigest(content) {
  return crypto.createHash('sha256')
    .update(Buffer.from(canonicalSerialize(content), 'utf8'))
    .digest('hex');
}

function validateManifestEnvelope(manifest, { verifyDigest = true } = {}) {
  assertNoUnknownKeys(
    manifest,
    new Set(['builtAt', 'content', 'contentDigest', 'display', 'kind', 'schemaVersion']),
    'release manifest',
  );
  if (manifest.kind !== MANIFEST_KIND) throw new Error(`unsupported manifest kind: ${manifest.kind}`);
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(`unsupported manifest schemaVersion: ${manifest.schemaVersion}`);
  }
  if (
    typeof manifest.builtAt !== 'string'
    || Number.isNaN(Date.parse(manifest.builtAt))
    || new Date(manifest.builtAt).toISOString() !== manifest.builtAt
  ) {
    throw new Error('release manifest builtAt must be a canonical ISO timestamp');
  }
  validateManifestContent(manifest.content);
  assertNoUnknownKeys(
    manifest.contentDigest,
    new Set(['algorithm', 'canonicalization', 'value']),
    'content digest',
  );
  if (manifest.contentDigest.algorithm !== CONTENT_DIGEST_ALGORITHM) {
    throw new Error('content digest algorithm must be sha256');
  }
  if (manifest.contentDigest.canonicalization !== CANONICALIZATION) {
    throw new Error(`unsupported canonicalization: ${manifest.contentDigest.canonicalization}`);
  }
  validateHash(manifest.contentDigest.value, 'content digest');
  assertNoUnknownKeys(manifest.display, new Set(['repository']), 'display metadata');
  assertNoUnknownKeys(
    manifest.display.repository,
    new Set(['branch', 'commitShort']),
    'display repository metadata',
  );
  requireNonEmptyString(manifest.display.repository.commitShort, 'display short commit');
  if (
    manifest.display.repository.branch !== null
    && (typeof manifest.display.repository.branch !== 'string' || !manifest.display.repository.branch)
  ) {
    throw new Error('display repository branch must be a non-empty string or null');
  }
  if (verifyDigest) {
    const expected = Buffer.from(calculateContentDigest(manifest.content), 'hex');
    const actual = Buffer.from(manifest.contentDigest.value, 'hex');
    if (!crypto.timingSafeEqual(expected, actual)) {
      throw new Error('release manifest content digest mismatch');
    }
  }
  return true;
}

module.exports = {
  ACTUAL_VERSION_PATTERN,
  CANONICALIZATION,
  CONTENT_DIGEST_ALGORITHM,
  GIT_COMMIT_PATTERN,
  MANIFEST_KIND,
  MANIFEST_SCHEMA_VERSION,
  RELEASE_MODES,
  RELEASE_PROFILE_RULES,
  RELEASE_VARIANTS,
  SHA256_PATTERN,
  assertNoUnknownKeys,
  assertPlainObject,
  calculateContentDigest,
  canonicalSerialize,
  compareStrings,
  isPlainObject,
  normalizeLogicalPath,
  normalizeOtaEvidence,
  normalizePublisherToolchain,
  requireNonEmptyString,
  validateActualAlignment,
  validateHash,
  validateManifestEnvelope,
  validateManifestContent,
};

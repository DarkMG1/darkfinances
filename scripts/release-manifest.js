#!/usr/bin/env node
/**
 * Content-addressed release provenance. This binds source and explicitly
 * supplied release evidence without embedding source, patches, or private data.
 * The digest provides integrity, not key-based authenticity.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { contractFingerprint } = require('./contract-fingerprint');
const { readActualAlignment } = require('./version-alignment');
const { resolveReleaseProfile } = require('./release-profile');
const { DASHBOARD_RUNTIME_FILES } = require('../finance-dashboard/lib/release-files');
const {
  CANONICALIZATION,
  CONTENT_DIGEST_ALGORITHM,
  GIT_COMMIT_PATTERN,
  MANIFEST_KIND,
  MANIFEST_SCHEMA_VERSION,
  RELEASE_MODES,
  RELEASE_VARIANTS,
  assertNoUnknownKeys,
  assertPlainObject,
  calculateContentDigest,
  canonicalSerialize,
  compareStrings,
  normalizeLogicalPath,
  normalizeOtaEvidence,
  requireNonEmptyString,
  validateHash,
  validateManifestEnvelope,
  validateManifestContent,
} = require('../finance-dashboard/lib/release-schema');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIGEST_VERSION = 1;
const HASH_CHUNK_BYTES = 64 * 1024;

const BUILD_OPTION_KEYS = new Set([
  'artifactPath',
  'backupAdditionalArchivePaths',
  'backupArchivePath',
  'backupManifestPath',
  'deployedPaths',
  'deployedRoot',
  'dirtyPatchPath',
  'expectedSourceDigest',
  'mode',
  'ota',
  'otaBranch',
  'otaResultPath',
  'releaseProfile',
  'root',
  'sourceArchivePath',
  'variant',
]);

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256Canonical(value) {
  return sha256Buffer(Buffer.from(canonicalSerialize(value), 'utf8'));
}

function readRegularFile(file, label = 'file') {
  const resolved = path.resolve(requireNonEmptyString(file, `${label} path`));
  let before;
  try {
    before = fs.lstatSync(resolved);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${label} not found: ${resolved}`);
    throw error;
  }
  if (before.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${resolved}`);
  if (!before.isFile()) throw new Error(`${label} must be a regular file: ${resolved}`);

  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const nonBlock = fs.constants.O_NONBLOCK || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow | nonBlock);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) throw new Error(`${label} must be a regular file: ${resolved}`);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed before it could be read`);
    }
    const buffer = fs.readFileSync(descriptor);
    const afterPath = fs.lstatSync(resolved);
    if (
      !afterPath.isFile()
      || afterPath.dev !== opened.dev
      || afterPath.ino !== opened.ino
    ) {
      throw new Error(`${label} path changed while it was being read`);
    }
    return { buffer, bytes: buffer.length, resolved };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function hashRegularFile(file, label = 'file', dependencies = {}) {
  const resolved = path.resolve(requireNonEmptyString(file, `${label} path`));
  let beforePath;
  try {
    beforePath = fs.lstatSync(resolved);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${label} not found: ${resolved}`);
    throw error;
  }
  if (beforePath.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${resolved}`);
  if (!beforePath.isFile()) throw new Error(`${label} must be a regular file: ${resolved}`);

  const readSync = dependencies.readSync || fs.readSync;
  const chunkBytes = dependencies.chunkBytes || HASH_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error('hash chunk size must be a positive safe integer');
  }
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const nonBlock = fs.constants.O_NONBLOCK || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow | nonBlock);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`${label} must be a regular file: ${resolved}`);
    if (before.dev !== beforePath.dev || before.ino !== beforePath.ino) {
      throw new Error(`${label} changed before it could be hashed`);
    }
    const hash = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(Math.min(chunkBytes, Math.max(1, before.size)));
    let offset = 0;
    while (offset < before.size) {
      const requested = Math.min(chunk.length, before.size - offset);
      const bytesRead = readSync(descriptor, chunk, 0, requested, offset);
      if (bytesRead <= 0) throw new Error(`${label} changed while it was being hashed`);
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(descriptor, extra, 0, 1, offset) !== 0) {
      throw new Error(`${label} changed while it was being hashed`);
    }
    const after = fs.fstatSync(descriptor);
    if (
      after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || after.ino !== before.ino
      || after.dev !== before.dev
    ) {
      throw new Error(`${label} changed while it was being hashed`);
    }
    const afterPath = fs.lstatSync(resolved);
    if (
      !afterPath.isFile()
      || afterPath.isSymbolicLink()
      || afterPath.dev !== after.dev
      || afterPath.ino !== after.ino
    ) {
      throw new Error(`${label} path changed while it was being hashed`);
    }
    return {
      bytes: before.size,
      executable: (before.mode & 0o111) !== 0,
      resolved,
      sha256: hash.digest('hex'),
    };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sha256File(file, dependencies) {
  return hashRegularFile(file, 'file', dependencies).sha256;
}

function fileEvidence(file, label, dependencies) {
  const { bytes, resolved, sha256 } = hashRegularFile(file, label, dependencies);
  return {
    file: path.basename(resolved),
    sha256,
    bytes,
  };
}

function readJson(file, label = file) {
  const { buffer } = readRegularFile(file, label);
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function normalizeGitPath(value, label = 'Git path') {
  const original = requireNonEmptyString(value, label);
  if (original.startsWith('/') || /^[A-Za-z]:[\\/]/.test(original)) {
    throw new Error(`${label} must be relative: ${original}`);
  }
  const parts = original.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`${label} is not a normalized relative path: ${original}`);
  }
  return original;
}

function resolveWithinRoot(root, logicalPath, label) {
  const normalized = normalizeLogicalPath(logicalPath, label);
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...normalized.split('/'));
  const relative = path.relative(resolvedRoot, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its root: ${logicalPath}`);
  }
  return { candidate, normalized };
}

function resolveGitPathWithinRoot(root, gitPath, label) {
  const normalized = normalizeGitPath(gitPath, label);
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...normalized.split('/'));
  const relative = path.relative(resolvedRoot, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its root: ${gitPath}`);
  }
  return { candidate, normalized };
}

function createGitRunner(root, spawn = spawnSync) {
  const cwd = path.resolve(root);
  return (args, options = {}) => spawn('git', args, {
    cwd,
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function runGit(gitRunner, args, { allowStatuses = [0], encoding = 'utf8', label = args.join(' ') } = {}) {
  const result = gitRunner(args, { encoding });
  if (!result || typeof result !== 'object') throw new Error(`git ${label} returned no result`);
  if (result.error) throw new Error(`git ${label} failed: ${result.error.message}`);
  if (!allowStatuses.includes(result.status)) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8').trim()
      : String(result.stderr || '').trim();
    throw new Error(`git ${label} failed${stderr ? `: ${stderr}` : ` with status ${result.status}`}`);
  }
  return result;
}

function gitText(gitRunner, args, options = {}) {
  const result = runGit(gitRunner, args, { ...options, encoding: 'utf8' });
  return String(result.stdout || '').trim();
}

function decodeGitPathList(stdout, label) {
  let text;
  if (Buffer.isBuffer(stdout)) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(stdout);
    } catch {
      throw new Error(`${label} contains a non-UTF-8 path`);
    }
  } else {
    text = String(stdout || '');
  }
  if (!text) return [];
  const values = text.split('\0');
  if (values.at(-1) === '') values.pop();
  if (values.some((value) => value.length === 0)) {
    throw new Error(`${label} contains an empty path`);
  }
  return values;
}

function decodeGitIndex(stdout) {
  const records = decodeGitPathList(stdout, 'tracked index listing');
  const entries = records.map((record) => {
    const separator = record.indexOf('\t');
    const metadata = separator === -1 ? '' : record.slice(0, separator);
    const gitPath = separator === -1 ? '' : record.slice(separator + 1);
    const match = metadata.match(/^([0-7]{6}) ([a-f0-9]+) ([0-3])$/);
    if (!match || !gitPath) throw new Error('tracked index listing is malformed');
    if (match[3] !== '0') throw new Error(`unmerged tracked source is not releasable: ${gitPath}`);
    return {
      mode: match[1],
      path: normalizeGitPath(gitPath, 'tracked source path'),
    };
  });
  entries.sort((left, right) => compareStrings(left.path, right.path));
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new Error('tracked source paths collide after normalization');
  }
  return entries;
}

function readSourceEntry(root, gitPath, scope) {
  const { candidate, normalized } = resolveGitPathWithinRoot(root, gitPath, `${scope} source path`);
  let stat;
  try {
    stat = fs.lstatSync(candidate);
  } catch (error) {
    if (scope === 'tracked' && error.code === 'ENOENT') {
      return { path: normalized, type: 'missing' };
    }
    if (error.code === 'ENOENT') {
      throw new Error(`untracked source disappeared while hashing: ${normalized}`);
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(candidate, { encoding: 'buffer' });
    return {
      path: normalized,
      type: 'symlink',
      sha256: sha256Buffer(target),
      bytes: target.length,
    };
  }
  if (!stat.isFile()) {
    throw new Error(`${scope} source is not a regular file or symlink: ${normalized}`);
  }
  const evidence = hashRegularFile(candidate, `${scope} source`);
  return {
    path: normalized,
    type: 'file',
    executable: evidence.executable,
    sha256: evidence.sha256,
    bytes: evidence.bytes,
  };
}

function normalizePaths(paths, label, normalizer = normalizeLogicalPath) {
  const normalized = paths.map((entry) => normalizer(entry, label));
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) {
    throw new Error(`${label} contains paths that collide after normalization`);
  }
  return [...unique].sort();
}

function buildSourceIdentity({ root = DEFAULT_ROOT, gitRunner = null } = {}) {
  const resolvedRoot = path.resolve(root);
  const runner = gitRunner || createGitRunner(resolvedRoot);
  const commit = gitText(runner, ['rev-parse', '--verify', 'HEAD'], { label: 'commit lookup' });
  if (!GIT_COMMIT_PATTERN.test(commit)) throw new Error(`git returned an invalid commit identity: ${commit}`);

  const shortResult = runGit(runner, ['rev-parse', '--short', 'HEAD'], {
    label: 'short commit lookup',
  });
  const commitShort = String(shortResult.stdout || '').trim() || commit.slice(0, 7);
  const branchResult = runGit(runner, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    allowStatuses: [0, 1],
    label: 'branch lookup',
  });
  const branch = branchResult.status === 0 ? String(branchResult.stdout || '').trim() || null : null;

  const trackedResult = runGit(runner, ['ls-files', '--stage', '-z'], {
    encoding: null,
    label: 'tracked file listing',
  });
  const untrackedResult = runGit(runner, ['ls-files', '-z', '--others', '--exclude-standard'], {
    encoding: null,
    label: 'untracked file listing',
  });
  const trackedIndex = decodeGitIndex(trackedResult.stdout);
  const trackedPaths = trackedIndex.map((entry) => entry.path);
  const untrackedPaths = normalizePaths(
    decodeGitPathList(untrackedResult.stdout, 'untracked file listing'),
    'untracked source path',
    normalizeGitPath,
  );
  const overlap = trackedPaths.find((entry) => untrackedPaths.includes(entry));
  if (overlap) throw new Error(`git reported ${overlap} as both tracked and untracked`);

  const trackedEntries = trackedPaths.map((entry) => readSourceEntry(resolvedRoot, entry, 'tracked'));
  const untrackedEntries = untrackedPaths.map((entry) => readSourceEntry(resolvedRoot, entry, 'untracked'));
  const trackedModeDirty = trackedEntries.some((entry, index) => (
    entry.type === 'file'
    && entry.executable !== (trackedIndex[index].mode === '100755')
  ));
  const dirtyResult = runGit(
    runner,
    ['diff', '--quiet', '--no-ext-diff', '--ignore-submodules=none', 'HEAD', '--'],
    { allowStatuses: [0, 1], label: 'tracked dirty check' },
  );
  const trackedDirty = dirtyResult.status === 1 || trackedModeDirty;
  const untrackedSource = untrackedPaths.length > 0;
  const state = trackedDirty
    ? (untrackedSource ? 'tracked-dirty-and-untracked-source' : 'tracked-dirty')
    : (untrackedSource ? 'untracked-source' : 'clean');

  const digestPayload = {
    version: SOURCE_DIGEST_VERSION,
    commit,
    state,
    tracked: trackedEntries,
    untracked: untrackedEntries,
  };

  return {
    commit,
    commitShort,
    branch,
    dirty: trackedDirty || untrackedSource,
    source: {
      algorithm: CONTENT_DIGEST_ALGORITHM,
      digest: sha256Canonical(digestPayload),
      state,
      trackedDirty,
      untrackedSource,
    },
  };
}

function collectDeployedFiles(deployedRoot, deployedPaths) {
  const root = path.resolve(requireNonEmptyString(deployedRoot, 'deployed root'));
  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`deployed root not found: ${root}`);
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`deployed root must be a real directory: ${root}`);
  }
  const realRoot = fs.realpathSync(root);
  const paths = normalizePaths(deployedPaths, 'deployed file path');

  return paths.map((logicalPath) => {
    const { candidate, normalized } = resolveWithinRoot(realRoot, logicalPath, 'deployed file path');
    let current = realRoot;
    for (const part of normalized.split('/')) {
      current = path.join(current, part);
      let stat;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error(`deployed file not found: ${normalized}`);
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`deployed file path must not contain symbolic links: ${normalized}`);
      }
    }
    const realCandidate = fs.realpathSync(candidate);
    const relative = path.relative(realRoot, realCandidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`deployed file escapes deployed root: ${normalized}`);
    }
    const evidence = hashRegularFile(realCandidate, `deployed file ${normalized}`);
    const afterRoot = fs.lstatSync(root);
    if (
      afterRoot.isSymbolicLink()
      || !afterRoot.isDirectory()
      || afterRoot.dev !== rootStat.dev
      || afterRoot.ino !== rootStat.ino
    ) {
      throw new Error('deployed root changed while files were being hashed');
    }
    let postCurrent = realRoot;
    for (const part of normalized.split('/')) {
      postCurrent = path.join(postCurrent, part);
      const stat = fs.lstatSync(postCurrent);
      if (stat.isSymbolicLink()) {
        throw new Error(`deployed file path gained a symbolic link: ${normalized}`);
      }
    }
    const postRealCandidate = fs.realpathSync(candidate);
    const postRelative = path.relative(realRoot, postRealCandidate);
    if (
      postRealCandidate !== realCandidate
      || postRelative === '..'
      || postRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(postRelative)
    ) {
      throw new Error(`deployed file path changed while hashing: ${normalized}`);
    }
    return {
      path: normalized,
      executable: evidence.executable,
      sha256: evidence.sha256,
      bytes: evidence.bytes,
    };
  });
}

function collectDashboardDeployment(root, deployedRoot, requestedPaths = null) {
  const expectedPaths = [...DASHBOARD_RUNTIME_FILES].sort();
  if (requestedPaths !== null) {
    if (!Array.isArray(requestedPaths) || requestedPaths.length === 0) {
      throw new Error('dashboard mode requires the complete runtime file allowlist');
    }
    const normalizedRequested = normalizePaths(requestedPaths, 'deployed file path');
    if (
      normalizedRequested.length !== expectedPaths.length
      || normalizedRequested.some((entry, index) => entry !== expectedPaths[index])
    ) {
      throw new Error('dashboard mode requires exactly DASHBOARD_RUNTIME_FILES');
    }
  }
  let sourceFiles;
  try {
    sourceFiles = collectDeployedFiles(
      path.join(root, 'finance-dashboard'),
      expectedPaths,
    );
  } catch (error) {
    throw new Error(`dashboard source verification failed: ${error.message}`);
  }
  const deployedFiles = collectDeployedFiles(deployedRoot, expectedPaths);
  for (let index = 0; index < sourceFiles.length; index += 1) {
    const source = sourceFiles[index];
    const deployed = deployedFiles[index];
    if (
      source.path !== deployed.path
      || source.sha256 !== deployed.sha256
      || source.bytes !== deployed.bytes
      || source.executable !== deployed.executable
    ) {
      throw new Error(`deployed dashboard file does not match repository source: ${source.path}`);
    }
  }
  return deployedFiles;
}

function defaultResolveAppConfig({ root, variant }) {
  // Load lazily so source-identity and canonicalization tests do not need Expo.
  const { getConfig } = require('@expo/config');
  const previous = process.env.FREE_IOS_SIDELOAD;
  if (variant === 'free-sideload') process.env.FREE_IOS_SIDELOAD = '1';
  else delete process.env.FREE_IOS_SIDELOAD;
  try {
    return getConfig(path.join(root, 'finance-app'), { skipSDKVersionRequirement: true }).exp;
  } finally {
    if (previous === undefined) delete process.env.FREE_IOS_SIDELOAD;
    else process.env.FREE_IOS_SIDELOAD = previous;
  }
}

function resolveRuntimeVersion(app) {
  if (typeof app.runtimeVersion === 'string' && app.runtimeVersion) return app.runtimeVersion;
  if (app.runtimeVersion?.policy === 'appVersion') {
    return requireNonEmptyString(app.version, 'Expo app version');
  }
  throw new Error('Expo runtimeVersion must resolve to a string or use the appVersion policy');
}

function normalizeAppIdentity(app, variant, profile) {
  assertPlainObject(app, 'resolved Expo config');
  const version = requireNonEmptyString(app.version, 'Expo app version');
  const runtimeVersion = resolveRuntimeVersion(app);
  const updateChannel = requireNonEmptyString(
    app.updates?.requestHeaders?.['expo-channel-name'],
    'Expo update channel',
  );
  const iosBuildNumber = requireNonEmptyString(String(app.ios?.buildNumber || ''), 'Expo iOS build number');
  if (variant === 'free-sideload') {
    if (runtimeVersion !== `${version}-free-sideload` || updateChannel !== 'free-sideload') {
      throw new Error('free-sideload config must use its isolated runtime and update channel');
    }
  } else if (runtimeVersion.endsWith('-free-sideload') || updateChannel !== 'production') {
    throw new Error('full base config must use the production channel and full runtime');
  }
  return {
    variant,
    releaseProfile: profile.name,
    version,
    runtimeVersion,
    updateChannel,
    iosBuildNumber,
  };
}

function otaEvidenceFromResult(file, { profile, expectedBranch = null } = {}) {
  const result = readJson(file, 'EAS update result');
  const updates = Array.isArray(result) ? result : result?.updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error('EAS update result must contain at least one update');
  }
  const normalized = updates.map((update) => {
    assertPlainObject(update, 'EAS update');
    return {
      id: requireNonEmptyString(update.id, 'EAS update ID'),
      groupId: requireNonEmptyString(update.group, 'EAS update group ID'),
      runtimeVersion: requireNonEmptyString(update.runtimeVersion, 'EAS update runtime version'),
      branch: requireNonEmptyString(update.branch, 'EAS update branch'),
      platform: requireNonEmptyString(update.platform, 'EAS update platform'),
    };
  });
  const single = (field, label) => {
    const values = [...new Set(normalized.map((entry) => entry[field]))];
    if (values.length !== 1) throw new Error(`EAS update result has ambiguous ${label}`);
    return values[0];
  };
  const branch = single('branch', 'branches');
  if (expectedBranch && branch !== expectedBranch) {
    throw new Error(`EAS update branch ${branch} does not match requested branch ${expectedBranch}`);
  }
  return normalizeOtaEvidence({
    groupId: single('groupId', 'group IDs'),
    runtimeVersion: single('runtimeVersion', 'runtime versions'),
    channel: profile.channel,
    branch,
    profile: profile.name,
    environment: profile.environment,
    updates: normalized.map(({ id, platform }) => ({ id, platform })),
  });
}

function inferMode(options) {
  if (options.mode !== undefined) {
    const mode = requireNonEmptyString(options.mode, 'release mode');
    if (!RELEASE_MODES.has(mode)) throw new Error(`unsupported release mode: ${mode}`);
    return mode;
  }
  const candidates = [];
  if (options.deployedRoot !== undefined || options.deployedPaths !== undefined) candidates.push('dashboard');
  if (options.artifactPath !== undefined) candidates.push('ipa');
  if (
    options.ota !== undefined
    || options.otaResultPath !== undefined
    || options.otaBranch !== undefined
  ) candidates.push('ota');
  if (
    options.backupManifestPath !== undefined
    || options.backupArchivePath !== undefined
    || options.backupAdditionalArchivePaths !== undefined
  ) candidates.push('backup');
  const unique = [...new Set(candidates)];
  if (unique.length > 1) {
    throw new Error(`release evidence is ambiguous; select --mode (${unique.join(', ')})`);
  }
  return unique[0] || 'source';
}

function validateModeOptions(options, mode) {
  const evidence = {
    dashboard: options.deployedRoot !== undefined || options.deployedPaths !== undefined,
    ipa: options.artifactPath !== undefined,
    ota: options.ota !== undefined
      || options.otaResultPath !== undefined
      || options.otaBranch !== undefined,
    backup: options.backupManifestPath !== undefined
      || options.backupArchivePath !== undefined
      || options.backupAdditionalArchivePaths !== undefined,
  };
  const incompatible = Object.entries(evidence)
    .filter(([evidenceMode, present]) => present && evidenceMode !== mode)
    .map(([evidenceMode]) => evidenceMode);
  if (incompatible.length > 0) {
    throw new Error(`${mode} mode cannot include ${incompatible.join(', ')} release evidence`);
  }
}

function clockIsoString(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('clock returned an invalid date');
  return date.toISOString();
}

function buildManifest(options = {}, dependencies = {}) {
  assertNoUnknownKeys(options, BUILD_OPTION_KEYS, 'manifest options');
  const root = path.resolve(options.root || dependencies.root || DEFAULT_ROOT);
  const variant = requireNonEmptyString(
    options.variant || dependencies.variant || 'full',
    'app variant',
  );
  if (!RELEASE_VARIANTS.has(variant)) throw new Error(`unsupported app variant: ${variant}`);
  const profile = resolveReleaseProfile(root, variant, options.releaseProfile || null);
  const mode = inferMode(options);
  validateModeOptions(options, mode);
  const sourceIdentity = buildSourceIdentity({
    root,
    gitRunner: dependencies.gitRunner || null,
  });
  if (options.expectedSourceDigest !== undefined) {
    validateHash(options.expectedSourceDigest, 'expected source digest');
    if (sourceIdentity.source.digest !== options.expectedSourceDigest) {
      throw new Error(
        `source changed during release operation: expected ${options.expectedSourceDigest}, got ${sourceIdentity.source.digest}`,
      );
    }
  }
  const resolveAppConfig = dependencies.resolveAppConfig || defaultResolveAppConfig;
  const app = normalizeAppIdentity(resolveAppConfig({ root, variant }), variant, profile);

  const lockfile = path.join(root, 'package-lock.json');
  const actual = readActualAlignment(root);

  const content = {
    mode,
    repository: {
      commit: sourceIdentity.commit,
      dirty: sourceIdentity.dirty,
      source: sourceIdentity.source,
    },
    lockfile: {
      path: 'package-lock.json',
      sha256: sha256File(lockfile),
    },
    actual,
    contract: {
      fingerprint: contractFingerprint(root),
    },
    app,
  };

  if (options.deployedRoot !== undefined || mode === 'dashboard') {
    if (!options.deployedRoot) throw new Error('dashboard mode requires --deployed-root');
    content.deployedFiles = collectDashboardDeployment(
      root,
      options.deployedRoot,
      options.deployedPaths || null,
    );
  }
  if (options.artifactPath !== undefined) {
    content.artifact = fileEvidence(options.artifactPath, 'artifact');
  }
  if (options.ota !== undefined && options.otaResultPath !== undefined) {
    throw new Error('explicit OTA fields and --ota-result cannot be combined');
  }
  if (options.ota !== undefined && options.otaBranch !== undefined) {
    throw new Error('OTA branch override is only valid with --ota-result');
  }
  if (options.ota !== undefined) {
    content.ota = normalizeOtaEvidence({
      ...options.ota,
      profile: options.ota.profile || profile.name,
      environment: options.ota.environment || profile.environment,
    });
  }
  if (options.otaResultPath !== undefined) {
    content.ota = otaEvidenceFromResult(options.otaResultPath, {
      profile,
      expectedBranch: options.otaBranch || null,
    });
  }
  if (content.ota && content.ota.runtimeVersion !== app.runtimeVersion) {
    throw new Error(
      `OTA runtime ${content.ota.runtimeVersion} does not match ${variant} app runtime ${app.runtimeVersion}`,
    );
  }
  const hasBackupManifest = options.backupManifestPath !== undefined;
  const hasBackupArchive = options.backupArchivePath !== undefined;
  if (hasBackupManifest !== hasBackupArchive) {
    throw new Error('backup evidence requires both --backup-manifest and --backup-archive');
  }
  if (hasBackupManifest) {
    const additionalPaths = options.backupAdditionalArchivePaths || [];
    if (!Array.isArray(additionalPaths)) {
      throw new Error('backup additional archive paths must be an array');
    }
    const additionalArchives = additionalPaths
      .map((archive) => fileEvidence(archive, 'additional backup archive'))
      .sort((left, right) => compareStrings(left.file, right.file));
    if (new Set(additionalArchives.map((archive) => archive.file)).size !== additionalArchives.length) {
      throw new Error('additional backup archive filenames are ambiguous');
    }
    content.backup = {
      manifest: fileEvidence(options.backupManifestPath, 'backup manifest'),
      archive: fileEvidence(options.backupArchivePath, 'backup archive'),
      ...(additionalArchives.length > 0 ? { additionalArchives } : {}),
    };
  } else if (options.backupAdditionalArchivePaths !== undefined) {
    throw new Error('additional backup archives require --backup-manifest and --backup-archive');
  }
  if (options.sourceArchivePath !== undefined || options.dirtyPatchPath !== undefined) {
    content.sourceEvidence = {
      ...(options.sourceArchivePath !== undefined
        ? { archive: fileEvidence(options.sourceArchivePath, 'source archive') }
        : {}),
      ...(options.dirtyPatchPath !== undefined
        ? { dirtyPatch: fileEvidence(options.dirtyPatchPath, 'dirty patch') }
        : {}),
    };
  }

  const finalSourceIdentity = buildSourceIdentity({
    root,
    gitRunner: dependencies.gitRunner || null,
  });
  if (
    finalSourceIdentity.commit !== sourceIdentity.commit
    || finalSourceIdentity.source.digest !== sourceIdentity.source.digest
  ) {
    throw new Error('source changed while release evidence was being assembled');
  }
  validateManifestContent(content);
  const clock = dependencies.clock || (() => new Date());
  return {
    kind: MANIFEST_KIND,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    builtAt: clockIsoString(clock),
    content,
    contentDigest: {
      algorithm: CONTENT_DIGEST_ALGORITHM,
      canonicalization: CANONICALIZATION,
      value: sha256Canonical(content),
    },
    display: {
      repository: {
        commitShort: sourceIdentity.commitShort,
        branch: sourceIdentity.branch,
      },
    },
  };
}

function recalculateContentDigest(manifest) {
  validateManifestEnvelope(manifest, { verifyDigest: false });
  return calculateContentDigest(manifest.content);
}

function verifyManifest(manifest) {
  validateManifestEnvelope(manifest);
  return true;
}

function optionValue(argv, index, inlineValue, flag) {
  if (inlineValue !== undefined) {
    if (inlineValue === '') throw new Error(`--${flag} requires a value`);
    return { value: inlineValue, consumed: 0 };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${flag} requires a value`);
  return { value, consumed: 1 };
}

function parseCliArgs(argv) {
  const parsed = {
    backupAdditionalArchivePaths: [],
    deployedPaths: [],
    otaUpdateIds: [],
    stdout: false,
  };
  const singular = new Set();
  const destinations = [];
  const names = {
    artifact: 'artifactPath',
    'backup-archive': 'backupArchivePath',
    'backup-manifest': 'backupManifestPath',
    'check-destination': 'checkDestination',
    'check-profile': 'checkProfile',
    'deployed-root': 'deployedRoot',
    'dirty-patch': 'dirtyPatchPath',
    'expected-source-digest': 'expectedSourceDigest',
    mode: 'mode',
    'ota-branch': 'otaBranch',
    'ota-channel': 'otaChannel',
    'ota-group-id': 'otaGroupId',
    'ota-result': 'otaResultPath',
    'ota-runtime': 'otaRuntimeVersion',
    profile: 'releaseProfile',
    root: 'root',
    'source-archive': 'sourceArchivePath',
    variant: 'variant',
    verify: 'verifyPath',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      destinations.push(arg);
      continue;
    }
    const separator = arg.indexOf('=');
    const flag = arg.slice(2, separator === -1 ? undefined : separator);
    const inlineValue = separator === -1 ? undefined : arg.slice(separator + 1);
    if (flag === 'stdout' || flag === 'help' || flag === 'source-digest') {
      if (inlineValue !== undefined) throw new Error(`--${flag} does not accept a value`);
      parsed[flag === 'source-digest' ? 'sourceDigest' : flag] = true;
      continue;
    }
    if (
      flag === 'backup-additional-archive'
      || flag === 'deployed-file'
      || flag === 'ota-update-id'
    ) {
      const { value, consumed } = optionValue(argv, index, inlineValue, flag);
      index += consumed;
      const property = flag === 'backup-additional-archive'
        ? 'backupAdditionalArchivePaths'
        : (flag === 'deployed-file' ? 'deployedPaths' : 'otaUpdateIds');
      parsed[property].push(value);
      continue;
    }
    const property = names[flag];
    if (!property) throw new Error(`unknown option: --${flag}`);
    if (singular.has(flag)) throw new Error(`--${flag} may only be supplied once`);
    singular.add(flag);
    const { value, consumed } = optionValue(argv, index, inlineValue, flag);
    index += consumed;
    parsed[property] = value;
  }
  if (destinations.length > 1) throw new Error('only one manifest destination may be supplied');
  parsed.destination = destinations[0] || null;
  if (parsed.backupAdditionalArchivePaths.length === 0) delete parsed.backupAdditionalArchivePaths;
  if (parsed.deployedPaths.length === 0) delete parsed.deployedPaths;
  if (parsed.otaUpdateIds.length === 0) delete parsed.otaUpdateIds;
  return parsed;
}

function cliBuildOptions(parsed, env = process.env) {
  const options = {};
  for (const key of [
    'artifactPath',
    'backupAdditionalArchivePaths',
    'backupArchivePath',
    'backupManifestPath',
    'deployedPaths',
    'deployedRoot',
    'dirtyPatchPath',
    'expectedSourceDigest',
    'mode',
    'otaResultPath',
    'releaseProfile',
    'root',
    'sourceArchivePath',
    'variant',
  ]) {
    if (parsed[key] !== undefined) options[key] = parsed[key];
  }
  if (!options.variant && env.RELEASE_VARIANT) options.variant = env.RELEASE_VARIANT;
  if (parsed.otaResultPath) {
    const conflictingResultFields = [
      parsed.otaChannel,
      parsed.otaGroupId,
      parsed.otaRuntimeVersion,
      parsed.otaUpdateIds,
    ].some((value) => value !== undefined);
    if (conflictingResultFields) {
      throw new Error('--ota-result cannot be combined with explicit update ID, group ID, runtime, or channel');
    }
    if (parsed.otaBranch !== undefined) options.otaBranch = parsed.otaBranch;
  }
  const directOta = [
    parsed.otaBranch,
    parsed.otaChannel,
    parsed.otaGroupId,
    parsed.otaRuntimeVersion,
    parsed.otaUpdateIds,
  ].some((value) => value !== undefined);
  if (directOta && !parsed.otaResultPath) {
    options.ota = {
      ...(parsed.otaGroupId ? { groupId: parsed.otaGroupId } : {}),
      ...(parsed.otaUpdateIds ? { updateIds: parsed.otaUpdateIds } : {}),
      runtimeVersion: parsed.otaRuntimeVersion,
      channel: parsed.otaChannel,
      branch: parsed.otaBranch,
    };
  }
  return options;
}

function protectedInputPaths(options) {
  return [
    ...(options.backupAdditionalArchivePaths || []),
    options.artifactPath,
    options.backupArchivePath,
    options.backupManifestPath,
    options.dirtyPatchPath,
    options.otaResultPath,
    options.sourceArchivePath,
  ].filter(Boolean).map((entry) => path.resolve(entry));
}

function isWithinPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function effectiveDestinationPath(destination) {
  const resolved = path.resolve(destination);
  let existingParent = path.dirname(resolved);
  const missingParts = [];
  while (!fs.existsSync(existingParent)) {
    const parent = path.dirname(existingParent);
    if (parent === existingParent) throw new Error('manifest destination has no existing parent');
    missingParts.unshift(path.basename(existingParent));
    existingParent = parent;
  }
  const parentStat = fs.lstatSync(existingParent);
  if (!parentStat.isDirectory()) throw new Error('manifest destination parent must be a directory');
  const realParent = fs.realpathSync(existingParent);
  return path.join(realParent, ...missingParts, path.basename(resolved));
}

function assertSafeDestination(destination, options, root) {
  const resolvedRoot = path.resolve(root);
  const realRoot = fs.realpathSync(resolvedRoot);
  const lexicalDestination = path.resolve(destination);
  const effectiveDestination = effectiveDestinationPath(lexicalDestination);
  if (isWithinPath(resolvedRoot, lexicalDestination) && !isWithinPath(realRoot, effectiveDestination)) {
    throw new Error('manifest destination escapes the repository through a symbolic link');
  }

  const protectedFiles = protectedInputPaths(options).map((entry) => fs.realpathSync(entry));
  if (protectedFiles.includes(effectiveDestination)) {
    throw new Error('manifest destination must not overwrite supplied release evidence');
  }

  if (options.deployedRoot) {
    const deployedPaths = options.deployedPaths || DASHBOARD_RUNTIME_FILES;
    const realDeployedRoot = fs.realpathSync(options.deployedRoot);
    for (const logicalPath of deployedPaths) {
      const { candidate } = resolveWithinRoot(realDeployedRoot, logicalPath, 'deployed file path');
      if (fs.realpathSync(candidate) === effectiveDestination) {
        throw new Error('manifest destination must not overwrite a bound deployed file');
      }
    }
  }

  if (isWithinPath(realRoot, effectiveDestination)) {
    const relative = path.relative(realRoot, effectiveDestination).split(path.sep).join('/');
    if (!relative) throw new Error('manifest destination must not replace the repository root');
    const tracked = runGit(
      createGitRunner(realRoot),
      ['ls-files', '--error-unmatch', '--', relative],
      { allowStatuses: [0, 1], label: 'manifest destination tracked-file check' },
    );
    if (tracked.status === 0) {
      throw new Error('manifest destination must not overwrite a tracked source file');
    }
    const ignored = runGit(
      createGitRunner(realRoot),
      ['check-ignore', '--quiet', '--no-index', '--', relative],
      { allowStatuses: [0, 1], label: 'manifest destination ignore check' },
    );
    if (ignored.status !== 0) {
      throw new Error('manifest destination inside the repository must be Git-ignored');
    }
  }

  if (fs.existsSync(effectiveDestination)) {
    const stat = fs.lstatSync(effectiveDestination);
    if (stat.isSymbolicLink()) throw new Error('manifest destination must not be a symbolic link');
    if (!stat.isFile()) throw new Error('manifest destination must be a regular file');
  }
  return effectiveDestination;
}

function writeManifestAtomic(destination, manifest) {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, destination);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function helpText() {
  return [
    'Usage: release-manifest.js [options] [destination]',
    '',
    'Modes: source (default), dashboard, ipa, ota, backup',
    '  --stdout',
    '  --source-digest',
    '  --root=<git-root>',
    '  --variant=<full|free-sideload>',
    '  --profile=<production|preview|free-sideload>',
    '  --mode=<mode>',
    '  --artifact=<file>',
    '  --check-destination=<path>',
    '  --check-profile=<production|preview|free-sideload>',
    '  --expected-source-digest=<sha256>',
    '  --deployed-root=<directory> [--deployed-file=<relative-path> ...]',
    '  --ota-result=<eas-json> [--ota-branch=<expected-branch>]',
    '  --ota-update-id=<id> [--ota-group-id=<id>] --ota-runtime=<runtime>',
    '    --ota-channel=<channel> --ota-branch=<branch>',
    '  --backup-manifest=<file> --backup-archive=<file>',
    '    [--backup-additional-archive=<file> ...]',
    '  --source-archive=<file> --dirty-patch=<file>',
    '  --verify=<manifest>',
    '',
  ].join('\n');
}

function main(argv = process.argv.slice(2), io = process) {
  try {
    const parsed = parseCliArgs(argv);
    if (parsed.help) {
      io.stdout.write(helpText());
      return 0;
    }
    if (parsed.checkProfile) {
      const incompatible = Object.entries(parsed).filter(([key, value]) => (
        !['checkProfile', 'destination', 'root', 'stdout', 'variant'].includes(key)
        && value !== false
        && value !== null
        && value !== undefined
        && (!Array.isArray(value) || value.length > 0)
      ));
      if (parsed.destination || parsed.stdout || incompatible.length > 0) {
        throw new Error('--check-profile cannot be combined with manifest generation options');
      }
      const variant = parsed.variant
        || (parsed.checkProfile === 'free-sideload' ? 'free-sideload' : 'full');
      const profile = resolveReleaseProfile(
        path.resolve(parsed.root || DEFAULT_ROOT),
        variant,
        parsed.checkProfile,
      );
      io.stdout.write(`${JSON.stringify(profile)}\n`);
      return 0;
    }
    if (parsed.sourceDigest) {
      const incompatible = Object.entries(parsed).filter(([key, value]) => (
        !['destination', 'root', 'sourceDigest', 'stdout'].includes(key)
        && value !== false
        && value !== null
        && value !== undefined
        && (!Array.isArray(value) || value.length > 0)
      ));
      if (parsed.destination || parsed.stdout || incompatible.length > 0) {
        throw new Error('--source-digest cannot be combined with manifest generation options');
      }
      const identity = buildSourceIdentity({ root: parsed.root || DEFAULT_ROOT });
      io.stdout.write(`${identity.source.digest}\n`);
      return 0;
    }
    if (parsed.checkDestination) {
      const incompatible = Object.entries(parsed).filter(([key, value]) => (
        !['checkDestination', 'destination', 'root', 'stdout'].includes(key)
        && value !== false
        && value !== null
        && value !== undefined
        && (!Array.isArray(value) || value.length > 0)
      ));
      if (parsed.destination || parsed.stdout || incompatible.length > 0) {
        throw new Error('--check-destination cannot be combined with manifest generation options');
      }
      assertSafeDestination(
        parsed.checkDestination,
        {},
        path.resolve(parsed.root || DEFAULT_ROOT),
      );
      io.stdout.write('release-manifest: destination ok\n');
      return 0;
    }
    if (parsed.verifyPath) {
      const incompatible = Object.entries(parsed).filter(([key, value]) => (
        key !== 'verifyPath'
        && value !== false
        && value !== null
        && value !== undefined
        && (!Array.isArray(value) || value.length > 0)
      ));
      if (incompatible.length > 0) {
        throw new Error('--verify cannot be combined with manifest generation options');
      }
      const manifest = readJson(parsed.verifyPath, 'release manifest');
      verifyManifest(manifest);
      io.stdout.write(`release-manifest: ok ${manifest.contentDigest.value}\n`);
      return 0;
    }

    if (parsed.stdout && parsed.destination) {
      throw new Error('--stdout cannot be combined with a manifest destination');
    }
    const options = cliBuildOptions(parsed);
    const manifest = buildManifest(options);
    if (parsed.stdout) {
      io.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      return 0;
    }

    const root = path.resolve(options.root || DEFAULT_ROOT);
    const requestedDestination = path.resolve(
      parsed.destination || path.join(root, 'build', 'release-manifest.json'),
    );
    assertSafeDestination(requestedDestination, options, root);
    fs.mkdirSync(path.dirname(requestedDestination), { recursive: true });
    const destination = assertSafeDestination(requestedDestination, options, root);
    writeManifestAtomic(destination, manifest);
    io.stdout.write(`${destination}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`release-manifest: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = {
  CANONICALIZATION,
  CONTENT_DIGEST_ALGORITHM,
  DASHBOARD_RUNTIME_FILES,
  HASH_CHUNK_BYTES,
  MANIFEST_SCHEMA_VERSION,
  buildManifest,
  buildSourceIdentity,
  canonicalSerialize,
  cliBuildOptions,
  collectDashboardDeployment,
  collectDeployedFiles,
  contractFingerprint,
  createGitRunner,
  fileEvidence,
  hashRegularFile,
  main,
  normalizeLogicalPath,
  otaEvidenceFromResult,
  parseCliArgs,
  recalculateContentDigest,
  sha256Canonical,
  sha256File,
  verifyManifest,
};

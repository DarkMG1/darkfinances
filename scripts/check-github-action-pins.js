#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_MANIFEST = path.join(ROOT, 'ops/toolchain/github-action-pins.json');
const DEFAULT_WORKFLOWS_DIR = path.join(ROOT, '.github/workflows');
const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const FLOATING_REF_PATTERN = /^[A-Za-z0-9._-]+$/;
const MANIFEST_TOP_KEYS = new Set(['schemaVersion', 'actions']);
const MANIFEST_ACTION_KEYS = new Set(['id', 'provenance', 'releaseTag', 'sha']);
const CANONICAL_STEP_USES_LINE = /^\s*-\s+uses:\s+\S+\s*(?:#.*)?$/;
function isJobLevelUses(line) {
  if (/^\s*-\s+uses:/.test(line)) return false;
  const match = line.match(/^(\s+)uses:/);
  if (!match) return false;
  return match[1].length <= 4;
}
const USES_KEY_LINE = /\buses\b/i;

const FORBIDDEN_USES_PATTERNS = [
  { pattern: /['"]uses['"]\s*:/, label: 'quoted uses key' },
  { pattern: /\buses\s+:/, label: 'space before colon in uses key' },
  { pattern: /\buses\s*:\s*[>|]/, label: 'block/flow scalar uses value' },
  { pattern: /\{\s*uses\s*:/, label: 'flow-map uses key' },
  { pattern: /^\s*-\s*&\w+.*uses:/, label: 'anchored uses step' },
  { pattern: /<<:\s*\*/, label: 'YAML merge key' },
];

function fail(message) {
  throw new Error(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listWorkflowFiles(workflowsDir = DEFAULT_WORKFLOWS_DIR) {
  if (!fs.existsSync(workflowsDir)) return [];
  return fs.readdirSync(workflowsDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => path.join(workflowsDir, name))
    .sort();
}

function parseManifest(manifestPath = DEFAULT_MANIFEST) {
  const manifest = readJson(manifestPath);
  const unknownTop = Object.keys(manifest).filter((key) => !MANIFEST_TOP_KEYS.has(key)).sort();
  if (unknownTop.length > 0) {
    fail(`github-action-pins manifest contains unsupported field${unknownTop.length === 1 ? '' : 's'}: ${unknownTop.join(', ')}`);
  }
  if (manifest.schemaVersion !== 1) fail(`unsupported github-action-pins schemaVersion: ${manifest.schemaVersion}`);
  if (!Array.isArray(manifest.actions) || manifest.actions.length === 0) {
    fail('github-action-pins manifest must contain at least one action');
  }
  const entries = new Map();
  for (const entry of manifest.actions) {
    if (!entry || typeof entry !== 'object') fail('manifest action entry must be an object');
    const unknown = Object.keys(entry).filter((key) => !MANIFEST_ACTION_KEYS.has(key)).sort();
    if (unknown.length > 0) {
      fail(`manifest action ${entry.id || '(unknown)'} contains unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
    }
    for (const key of MANIFEST_ACTION_KEYS) {
      if (typeof entry[key] !== 'string' || entry[key].length === 0) {
        fail(`manifest action entry missing ${key}`);
      }
    }
    if (!entry.id.includes('/')) fail(`manifest action id must be owner/repo form: ${entry.id}`);
    if (!/^v\d+\.\d+\.\d+$/.test(entry.releaseTag)) {
      fail(`manifest action ${entry.id} releaseTag must be an exact vX.Y.Z tag (${entry.releaseTag})`);
    }
    if (!SHA_PATTERN.test(entry.sha)) fail(`manifest action ${entry.id} sha must be a 40-char commit`);
    const duplicate = entries.get(entry.id);
    if (duplicate) fail(`duplicate manifest action id: ${entry.id}`);
    entries.set(entry.id, {
      id: entry.id,
      releaseTag: entry.releaseTag,
      sha: entry.sha.toLowerCase(),
      provenance: entry.provenance,
    });
  }
  return entries;
}

function rejectYamlMergeKeys(content, workflowPath) {
  const workflow = path.basename(workflowPath);
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/<<:\s*\*/.test(line)) {
      fail(`${workflow}:${index + 1} YAML merge keys are not permitted: ${trimmed}`);
    }
  }
}

function extractUsesReferences(content, workflowPath) {
  const refs = [];
  const workflow = path.basename(workflowPath);
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!USES_KEY_LINE.test(line)) continue;

    for (const forbidden of FORBIDDEN_USES_PATTERNS) {
      if (forbidden.pattern.test(line)) {
        fail(`${workflow}:${index + 1} uses non-canonical ${forbidden.label}: ${trimmed}`);
      }
    }
    if (isJobLevelUses(line)) {
      fail(`${workflow}:${index + 1} job-level reusable workflow uses is not permitted: ${trimmed}`);
    }
    if (!CANONICAL_STEP_USES_LINE.test(line)) {
      const stepPropertyUses = /^\s{6,}uses:\s+\S+/.test(line);
      if (!stepPropertyUses) {
        fail(`${workflow}:${index + 1} uses mapping is not canonical YAML (expected "- uses: …" or step "uses:" under "- name:"): ${trimmed}`);
      }
      const propertyMatch = line.match(/^\s+uses:\s+(.+?)\s*(?:#.*)?$/);
      if (!propertyMatch) {
        fail(`${workflow}:${index + 1} failed to parse step property uses mapping: ${trimmed}`);
      }
      const raw = propertyMatch[1].replace(/^['"]|['"]$/g, '');
      refs.push({ workflow, line: index + 1, raw });
      continue;
    }

    const match = line.match(/^\s*-\s+uses:\s+(.+?)\s*(?:#.*)?$/);
    if (!match) {
      fail(`${workflow}:${index + 1} failed to parse canonical uses mapping: ${trimmed}`);
    }
    const raw = match[1].replace(/^['"]|['"]$/g, '');
    refs.push({ workflow, line: index + 1, raw });
  }
  return refs;
}

function classifyUsesReference(ref) {
  if (ref.raw.startsWith('./') || ref.raw.startsWith('../')) {
    return { kind: 'local', ref: ref.raw };
  }
  const at = ref.raw.lastIndexOf('@');
  if (at <= 0) fail(`${ref.workflow}:${ref.line} uses malformed action reference: ${ref.raw}`);
  const actionId = ref.raw.slice(0, at);
  const suffix = ref.raw.slice(at + 1);
  if (!actionId.includes('/')) {
    fail(`${ref.workflow}:${ref.line} external action must use owner/repo form: ${ref.raw}`);
  }
  if (SHA_PATTERN.test(suffix)) {
    return { kind: 'pinned', id: actionId, sha: suffix.toLowerCase(), ref: ref.raw };
  }
  if (FLOATING_REF_PATTERN.test(suffix)) {
    return { kind: 'floating', id: actionId, suffix, ref: ref.raw };
  }
  fail(`${ref.workflow}:${ref.line} action reference has unsupported suffix: ${ref.raw}`);
}

function defaultLsRemote(repoUrl, ref) {
  const result = spawnSync('git', ['ls-remote', repoUrl, ref], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail(`git ls-remote failed for ${repoUrl} ${ref}${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  }
  const line = String(result.stdout || '').trim().split('\n').find(Boolean);
  if (!line) fail(`git ls-remote returned no object for ${repoUrl} ${ref}`);
  const sha = line.split('\t')[0]?.trim();
  if (!SHA_PATTERN.test(sha || '')) fail(`git ls-remote returned invalid sha for ${repoUrl} ${ref}`);
  return sha.toLowerCase();
}

function verifyUpstreamPins(manifest, lsRemote = defaultLsRemote) {
  for (const entry of manifest.values()) {
    const repositoryId = entry.id.split('/').slice(0, 2).join('/');
    const repoUrl = `https://github.com/${repositoryId}.git`;
    const tagRef = `refs/tags/${entry.releaseTag}`;
    let remoteSha = null;
    try {
      remoteSha = lsRemote(repoUrl, `${tagRef}^{}`);
    } catch (peelError) {
      remoteSha = lsRemote(repoUrl, tagRef);
      if (remoteSha !== entry.sha) {
        throw peelError;
      }
    }
    if (remoteSha !== entry.sha) {
      fail(`upstream tag ${entry.id}@${entry.releaseTag} is ${remoteSha}, manifest records ${entry.sha}`);
    }
  }
}

function checkGithubActionPins({
  manifestPath = DEFAULT_MANIFEST,
  workflowsDir = DEFAULT_WORKFLOWS_DIR,
  readFile = fs.readFileSync,
  verifyUpstream = false,
  lsRemote = defaultLsRemote,
} = {}) {
  const manifest = parseManifest(manifestPath);
  if (verifyUpstream) verifyUpstreamPins(manifest, lsRemote);

  const workflowFiles = listWorkflowFiles(workflowsDir);
  if (workflowFiles.length === 0) fail('no workflow files found to validate');

  const usedExternal = new Map();
  for (const workflowPath of workflowFiles) {
    const content = readFile(workflowPath, 'utf8');
    rejectYamlMergeKeys(content, workflowPath);
    for (const ref of extractUsesReferences(content, workflowPath)) {
      const classified = classifyUsesReference(ref);
      if (classified.kind === 'local') continue;
      if (classified.kind === 'floating') {
        fail(`${ref.workflow}:${ref.line} uses floating action ref ${classified.ref}; pin an exact 40-char commit SHA`);
      }
      const manifestEntry = manifest.get(classified.id);
      if (!manifestEntry) {
        fail(`${ref.workflow}:${ref.line} uses unknown external action ${classified.id}; add it to ops/toolchain/github-action-pins.json`);
      }
      if (manifestEntry.sha !== classified.sha) {
        fail(
          `${ref.workflow}:${ref.line} action pin mismatch for ${classified.id}: workflow uses ${classified.sha}, manifest records ${manifestEntry.sha}`,
        );
      }
      const prior = usedExternal.get(classified.id);
      usedExternal.set(classified.id, prior ? prior + 1 : 1);
    }
  }

  for (const [actionId] of manifest.entries()) {
    if (!usedExternal.has(actionId)) {
      fail(`stale manifest entry for ${actionId}; remove it or reference the action from a workflow`);
    }
  }

  return {
    workflows: workflowFiles.map((file) => path.basename(file)).sort(),
    actions: [...manifest.values()].sort((left, right) => left.id.localeCompare(right.id)),
    externalUses: [...usedExternal.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function main() {
  const verifyUpstream = process.argv.includes('--verify-upstream');
  try {
    const result = checkGithubActionPins({ verifyUpstream });
    const suffix = verifyUpstream ? ', upstream verified' : '';
    console.log(
      `action-pins: ok (${result.workflows.length} workflow(s), ${result.actions.length} pinned action(s)${suffix})`,
    );
  } catch (error) {
    console.error(`action-pins: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = {
  CANONICAL_STEP_USES_LINE,
  FORBIDDEN_USES_PATTERNS,
  isJobLevelUses,
  checkGithubActionPins,
  classifyUsesReference,
  defaultLsRemote,
  extractUsesReferences,
  listWorkflowFiles,
  parseManifest,
  rejectYamlMergeKeys,
  verifyUpstreamPins,
};

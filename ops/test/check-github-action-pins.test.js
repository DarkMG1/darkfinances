'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  checkGithubActionPins,
  classifyUsesReference,
  extractUsesReferences,
  parseManifest,
  rejectYamlMergeKeys,
  verifyUpstreamPins,
} = require('../../scripts/check-github-action-pins');

const repositoryRoot = path.resolve(__dirname, '..', '..');

function writeWorkflow(root, name, content) {
  const workflowsDir = path.join(root, '.github/workflows');
  fs.mkdirSync(workflowsDir, { recursive: true });
  fs.writeFileSync(path.join(workflowsDir, name), content);
}

function writeManifest(root, actions) {
  const manifestDir = path.join(root, 'ops/toolchain');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(path.join(manifestDir, 'github-action-pins.json'), JSON.stringify({
    schemaVersion: 1,
    actions,
  }));
}

test('parseManifest rejects duplicate action ids and unknown fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'action-pins-'));
  const manifestPath = path.join(dir, 'pins.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    actions: [
      {
        id: 'actions/checkout',
        releaseTag: 'v4.4.0',
        sha: 'a'.repeat(40),
        provenance: 'https://example.com/a',
        extra: 'nope',
      },
    ],
  }));
  assert.throws(() => parseManifest(manifestPath), /unsupported field/);
});

test('extractUsesReferences rejects adversarial uses syntax', () => {
  const cases = [
    '      - "uses" : actions/checkout@' + 'a'.repeat(40),
    '      - uses : actions/checkout@' + 'a'.repeat(40),
    '      - uses: >',
    '      - uses: |',
    '      - { uses: actions/checkout@' + 'a'.repeat(40) + ' }',
    '      - &anchor uses: actions/checkout@' + 'a'.repeat(40),
  ];
  for (const line of cases) {
    assert.throws(
      () => extractUsesReferences(['jobs:', '  verify:', '    steps:', line].join('\n'), 'ci.yml'),
      /non-canonical|not canonical|failed to parse/,
    );
  }
  assert.throws(
    () => rejectYamlMergeKeys(['jobs:', '  verify:', '    steps:', '      - <<: *anchor'].join('\n'), 'ci.yml'),
    /merge keys are not permitted/,
  );
});

test('extractUsesReferences accepts step property uses under - name', () => {
  const refs = extractUsesReferences([
    'jobs:',
    '  verify:',
    '    steps:',
    '      - name: Upload artifact',
    '        uses: actions/upload-artifact@' + 'a'.repeat(40),
  ].join('\n'), 'ci.yml');
  assert.equal(refs.length, 1);
  assert.match(refs[0].raw, /^actions\/upload-artifact@/);
});

test('extractUsesReferences rejects job-level reusable workflow uses', () => {
  assert.throws(
    () => extractUsesReferences([
      'jobs:',
      '  call-workflow:',
      '    uses: org/repo/.github/workflows/ci.yml@' + 'a'.repeat(40),
    ].join('\n'), 'ci.yml'),
    /job-level reusable workflow uses is not permitted/,
  );
});

test('classifyUsesReference accepts local actions and rejects floating refs', () => {
  assert.deepEqual(classifyUsesReference({ raw: './.github/actions/local', workflow: 'ci.yml', line: 1 }), {
    kind: 'local',
    ref: './.github/actions/local',
  });
  assert.deepEqual(classifyUsesReference({ raw: 'actions/checkout@v4', workflow: 'ci.yml', line: 1 }), {
    kind: 'floating',
    id: 'actions/checkout',
    suffix: 'v4',
    ref: 'actions/checkout@v4',
  });
});

test('checkGithubActionPins rejects workflow/manifest SHA mismatch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'action-pins-'));
  writeManifest(root, [{
    id: 'actions/checkout',
    releaseTag: 'v4.4.0',
    sha: '11d5960a326750d5838078e36cf38b85af677262',
    provenance: 'https://github.com/actions/checkout/releases/tag/v4.4.0',
  }]);
  writeWorkflow(root, 'ci.yml', [
    'jobs:',
    '  verify:',
    '    steps:',
    '      - uses: actions/checkout@' + 'b'.repeat(40),
  ].join('\n'));
  assert.throws(
    () => checkGithubActionPins({
      manifestPath: path.join(root, 'ops/toolchain/github-action-pins.json'),
      workflowsDir: path.join(root, '.github/workflows'),
    }),
    /action pin mismatch/,
  );
});

test('verifyUpstreamPins detects manifest/upstream mismatch via DI lsRemote', () => {
  const manifest = parseManifest(path.join(repositoryRoot, 'ops/toolchain/github-action-pins.json'));
  assert.throws(
    () => verifyUpstreamPins(manifest, () => 'b'.repeat(40)),
    /upstream tag actions\/checkout@v4\.4\.0 is/,
  );
});

test('verifyUpstreamPins accepts matching upstream tag refs', () => {
  const manifest = parseManifest(path.join(repositoryRoot, 'ops/toolchain/github-action-pins.json'));
  const requestedRepos = [];
  assert.doesNotThrow(() => verifyUpstreamPins(manifest, (repoUrl, ref) => {
    requestedRepos.push(repoUrl);
    const entry = [...manifest.values()].find((item) => {
      const repositoryId = item.id.split('/').slice(0, 2).join('/');
      return repoUrl.includes(repositoryId);
    });
    return entry.sha;
  }));
  assert.ok(requestedRepos.includes('https://github.com/github/codeql-action.git'));
  assert.equal(requestedRepos.some((repoUrl) => /codeql-action\/(?:init|analyze)\.git/.test(repoUrl)), false);
});

test('repository workflows contain only manifest-pinned external actions', () => {
  const result = checkGithubActionPins();
  assert.ok(result.workflows.length >= 5);
  assert.ok(result.externalUses.length > 0);
  for (const workflowPath of fs.readdirSync(path.join(repositoryRoot, '.github/workflows'))) {
    const content = fs.readFileSync(path.join(repositoryRoot, '.github/workflows', workflowPath), 'utf8');
    assert.doesNotMatch(content, /cache:\s*npm/);
    assert.doesNotMatch(content, /cache:\s*gradle/);
    assert.doesNotMatch(content, /actions\/cache@/);
    assert.doesNotMatch(content, /permissions:[\s\S]*actions:\s*write/);
    for (const ref of extractUsesReferences(content, workflowPath)) {
      const classified = classifyUsesReference(ref);
      if (classified.kind === 'local') continue;
      assert.equal(classified.kind, 'pinned', `${workflowPath}:${ref.line} must pin ${ref.raw}`);
    }
    assert.doesNotMatch(content, /uses:\s*[^/\n]+@(v\d+|latest|main|master)\b/);
    assert.doesNotMatch(content, /\bnpx expo\b/);
    assert.doesNotMatch(content, /PATH:\s*\$\{\{\s*env\.PATH\s*\}\}/);
  }
});

test('ci.yml merge gate invokes upstream action pin verifier', () => {
  const ci = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /node scripts\/check-github-action-pins\.js --verify-upstream/);
});

test('native and stress workflows invoke supply-chain preflight npm scripts', () => {
  for (const name of [
    'ios-pr-smoke.yml',
    'maestro-full-suite.yml',
    'android-compile-smoke.yml',
    'shutdown-stress.yml',
  ]) {
    const workflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows', name), 'utf8');
    assert.match(workflow, /Supply-chain preflight \(pinned actions \+ vulnerability gate\)/);
    assert.match(workflow, /npm run check:action-pins:upstream/);
    assert.match(workflow, /npm run check:vulnerabilities/);
  }
});

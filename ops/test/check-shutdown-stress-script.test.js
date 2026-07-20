'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const packageJsonPath = path.join(repoRoot, 'package.json');
const stressTestRelative = 'finance-dashboard/test/query-scaling-shutdown-stress.test.js';
const stressTestPath = path.join(repoRoot, stressTestRelative);
const workflowPath = path.join(repoRoot, '.github/workflows/shutdown-stress.yml');
const opsReadmePath = path.join(repoRoot, 'ops/README.md');
const queryScalingDocPath = path.join(repoRoot, 'finance-dashboard/docs/query-scaling.md');

function readPackageScript(name) {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  return pkg.scripts[name];
}

function parseShutdownStressCommand(script) {
  const env = {};
  let remainder = script;
  while (true) {
    const match = remainder.match(/^([A-Z0-9_]+=\S+)\s+/);
    if (!match) break;
    const [key, ...valueParts] = match[1].split('=');
    env[key] = valueParts.join('=');
    remainder = remainder.slice(match[0].length);
  }
  const tokens = remainder.split(/\s+/).filter(Boolean);
  return { env, tokens };
}

test('check:shutdown-stress sets stress env and runs node --test before the dedicated file', () => {
  const script = readPackageScript('check:shutdown-stress');
  assert.match(script, /FINANCE_QUERY_SHUTDOWN_STRESS=1/);
  assert.match(script, /ALLOW_RAW_ACTUAL_API=1/);
  assert.doesNotMatch(script, /npm --prefix finance-dashboard test/);

  const { env, tokens } = parseShutdownStressCommand(script);
  assert.equal(env.FINANCE_QUERY_SHUTDOWN_STRESS, '1');
  assert.equal(env.ALLOW_RAW_ACTUAL_API, '1');

  const testFlagIndex = tokens.indexOf('--test');
  const fileIndex = tokens.indexOf(stressTestRelative);
  assert.ok(testFlagIndex >= 0, 'expected node --test flag');
  assert.ok(fileIndex > testFlagIndex, 'test file must follow node flags');
  assert.equal(tokens[0], 'node');
  assert.deepEqual(tokens.filter((token) => token.endsWith('.test.js')), [stressTestRelative]);
  assert.equal(fs.existsSync(stressTestPath), true);
});

test('shutdown stress docs and workflow invoke npm run check:shutdown-stress', () => {
  const opsReadme = fs.readFileSync(opsReadmePath, 'utf8');
  const queryScalingDoc = fs.readFileSync(queryScalingDocPath, 'utf8');
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  assert.match(opsReadme, /npm run check:shutdown-stress/);
  assert.match(opsReadme, /node --test finance-dashboard\/test\/query-scaling-shutdown-stress\.test\.js/);
  assert.match(queryScalingDoc, /\[`\.\.\/\.\.\/ops\/README\.md`\]\(\.\.\/\.\.\/ops\/README\.md#graceful-shutdown-verification\)/);
  assert.match(workflow, /node scripts\/ensure-declared-npm\.js[\s\S]*npm ci[\s\S]*npm run check:shutdown-stress/);
  assert.doesNotMatch(workflow, /test-name-pattern/);
});

test('check:shutdown-stress reduced profile executes only the dedicated stress file', {
  timeout: 180_000,
}, () => {
  const script = readPackageScript('check:shutdown-stress');
  const childEnv = {
    ...process.env,
    FINANCE_QUERY_SHUTDOWN_STRESS_SERIAL: '1',
    FINANCE_QUERY_SHUTDOWN_STRESS_PARALLEL: '1',
    FINANCE_QUERY_SHUTDOWN_STRESS_WORKERS: '1',
  };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('NODE_TEST_')) delete childEnv[key];
  }
  const result = spawnSync(script, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: true,
    env: childEnv,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /graceful shutdown in-flight read stress \(serial\)/);
  assert.match(output, /graceful shutdown in-flight read stress \(parallel\)/);
  assert.doesNotMatch(output, /vendor:chart-js:verify/);
  assert.doesNotMatch(output, /browser dashboard/);
});

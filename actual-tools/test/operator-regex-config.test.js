'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  CONFIG_ERROR_CODE,
  DEFAULT_LIMITS,
  OperatorRegexConfigError,
  compilePatternList,
  compilePatternUnion,
  loadBuildRulesConfig,
  loadCollectionRule,
  readCollectionRule,
  validatePatternSources,
  validateSkipNames,
} = require('../lib/operator-regex-config');

const toolsRoot = path.resolve(__dirname, '..');

function tempConfigFile(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-regex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, content);
  return file;
}

test('valid escaped patterns compile and match expected labels', () => {
  const regex = compilePatternUnion(['\\balex\\b', 'example surname'], { setLabel: 'debtor alex' });
  assert.match('Payment from Alex Example', regex);
  assert.match('example surname transfer', regex);
  assert.doesNotMatch('galaxy', regex);
});

test('malformed regex syntax fails with stable configuration error', () => {
  assert.throws(
    () => validatePatternSources(['(unclosed'], { setLabel: 'skipPatterns' }),
    (error) => error instanceof OperatorRegexConfigError
      && error.code === CONFIG_ERROR_CODE
      && /invalid syntax/.test(error.message),
  );
});

test('nested quantifier patterns are rejected as unsafe', () => {
  assert.throws(
    () => validatePatternSources(['(a+)+$'], { setLabel: 'skipPatterns' }),
    (error) => error instanceof OperatorRegexConfigError && /not safe/.test(error.message),
  );
});

test('ambiguous overlapping alternatives are rejected as unsafe', () => {
  assert.throws(
    () => validatePatternSources(['(.*|.*)*'], { setLabel: 'skipPatterns' }),
    (error) => error instanceof OperatorRegexConfigError && /not safe/.test(error.message),
  );
});

test('excessive pattern count and length are rejected', () => {
  const tooMany = Array.from({ length: DEFAULT_LIMITS.maxPatternsPerSet + 1 }, (_, index) => `p${index}`);
  assert.throws(
    () => validatePatternSources(tooMany, { setLabel: 'skipPatterns' }),
    /exceeds maximum pattern count/,
  );

  const tooLong = 'a'.repeat(DEFAULT_LIMITS.maxPatternLength + 1);
  assert.throws(
    () => validatePatternSources([tooLong], { setLabel: 'skipPatterns' }),
    /exceeds maximum length/,
  );

  const aggregate = Array.from(
    { length: DEFAULT_LIMITS.maxPatternsPerSet },
    () => 'a'.repeat(Math.ceil(DEFAULT_LIMITS.maxAggregatePatternLength / DEFAULT_LIMITS.maxPatternsPerSet) + 1),
  );
  assert.throws(
    () => validatePatternSources(aggregate, { setLabel: 'skipPatterns' }),
    /aggregate pattern length exceeds maximum/,
  );
});

test('zero-width and universal matchers that match empty input are rejected', () => {
  for (const pattern of ['.*', '|', '(?:)', '(?:foo|)', '^$']) {
    assert.throws(
      () => validatePatternSources([pattern], { setLabel: 'skipPatterns' }),
      (error) => error instanceof OperatorRegexConfigError && /must not match empty input/.test(error.message),
      `expected rejection for ${pattern}`,
    );
  }
});

test('anchored literals and word boundaries remain valid', () => {
  const patterns = compilePatternList(['\\balex\\b', '^payment', 'literal merchant'], { setLabel: 'skipPatterns' });
  assert.equal(patterns.length, 3);
  assert.match('Payment from Alex', patterns[0]);
  assert.doesNotMatch('', patterns[0]);
  assert.match('payment sent', patterns[1]);
  assert.doesNotMatch('', patterns[1]);
  assert.match('literal merchant charge', patterns[2]);
  assert.doesNotMatch('', patterns[2]);
});

test('skipNames count and length are bounded before build-rules would init Actual', () => {
  assert.throws(
    () => validateSkipNames(Array.from({ length: DEFAULT_LIMITS.maxSkipNames + 1 }, (_, index) => `name${index}`)),
    /exceeds maximum entry count/,
  );
  assert.throws(
    () => validateSkipNames(['x'.repeat(DEFAULT_LIMITS.maxSkipNameLength + 1)]),
    /exceeds maximum length/,
  );
  const aggregate = Array.from(
    { length: 20 },
    () => 'n'.repeat(Math.ceil(DEFAULT_LIMITS.maxSkipNamesAggregateLength / 20) + 1),
  );
  assert.throws(
    () => validateSkipNames(aggregate),
    /aggregate length exceeds maximum/,
  );
});

test('build-rules rejects excessive skipNames before Actual init', (t) => {
  const configPath = tempConfigFile(t, JSON.stringify({
    skipNames: Array.from({ length: DEFAULT_LIMITS.maxSkipNames + 1 }, (_, index) => `payee-${index}`),
  }));
  const result = runScriptFixture(t, 'build-rules.js', {
    configPath,
    env: { FIX_DATA_DIR: '/tmp/darkfinances-regex-test' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Operator regex configuration is invalid/);
  assert.doesNotMatch(result.stderr, /init-should-not-run/);
});

test('build-rules config validation accepts missing file and rejects invalid skipPatterns', (t) => {
  const missing = path.join(os.tmpdir(), `missing-build-rules-${process.pid}.json`);
  const empty = loadBuildRulesConfig(missing);
  assert.deepEqual([...empty.skipNames], []);
  assert.deepEqual(empty.skipPatterns, []);

  const badFile = tempConfigFile(t, JSON.stringify({ skipPatterns: ['(a+)+$'] }));
  assert.throws(() => loadBuildRulesConfig(badFile), OperatorRegexConfigError);
});

test('collection rule validation rejects combined debtor unions that exceed aggregate length', () => {
  const unit = `literal${'x'.repeat(193)}`;
  const patterns = Array.from({ length: 20 }, () => unit);
  assert.throws(
    () => readCollectionRule({
      events: {
        trip: {
          group: '1',
          tag: 'ev-trip',
          start: '2026-01-01',
          debtors: { alex: { patterns } },
        },
      },
    }, 'trip'),
    /combined pattern exceeds maximum length/,
  );
});

test('collection rule validation rejects incomplete and unsafe debtor patterns', () => {
  assert.throws(
    () => readCollectionRule({ events: { trip: { group: '1', tag: 'ev-trip', start: '2026-01-01', debtors: {} } } }, 'trip'),
    /requires debtors/,
  );
  assert.throws(
    () => readCollectionRule({
      events: {
        trip: {
          group: '1',
          tag: 'ev-trip',
          start: '2026-01-01',
          debtors: { alex: { patterns: ['(a+)+$'] } },
        },
      },
    }, 'trip'),
    /not safe/,
  );
});

test('compilePatternList returns independent matchers for build-rules skip patterns', () => {
  const patterns = compilePatternList(['custom payment pattern'], { setLabel: 'skipPatterns' });
  assert.equal(patterns.length, 1);
  assert.match('custom payment pattern here', patterns[0]);
});

function installMockActualTree(root) {
  const apiDir = path.join(root, 'node_modules', '@actual-app', 'api');
  fs.mkdirSync(apiDir, { recursive: true });
  fs.writeFileSync(path.join(apiDir, 'package.json'), JSON.stringify({ name: '@actual-app/api', main: 'index.js' }));
  fs.writeFileSync(path.join(apiDir, 'index.js'), `
let initCalls = 0;
module.exports = {
  init: async () => { initCalls++; throw new Error('init-should-not-run'); },
  downloadBudget: async () => { throw new Error('download-should-not-run'); },
  shutdown: async () => {},
  get __initCalls() { return initCalls; },
};
`);
}

function installMockSplitwiseTree(root) {
  fs.writeFileSync(path.join(root, 'splitwise-lib.js'), `
module.exports = {
  getGroupDebts: async () => { throw new Error('splitwise-should-not-run'); },
};
`);
}

function runScriptFixture(t, scriptName, { configPath, env = {}, extraFiles = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-regex-script-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(toolsRoot, 'lib'), path.join(dir, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(toolsRoot, scriptName), path.join(dir, scriptName));
  installMockActualTree(dir);
  installMockSplitwiseTree(dir);
  for (const [name, content] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return spawnSync(process.execPath, [path.join(dir, scriptName)], {
    cwd: dir,
    env: {
      ...process.env,
      NODE_PATH: [
        path.join(toolsRoot, 'node_modules'),
        path.join(toolsRoot, '..', 'node_modules'),
      ].join(path.delimiter),
      ...env,
      ...(scriptName === 'event-collect.js'
        ? { COLLECTION_RULES_PATH: configPath }
        : { BUILD_RULES_CONFIG_PATH: configPath }),
    },
    encoding: 'utf8',
  });
}

test('event-collect rejects invalid config before Actual init or Splitwise calls', (t) => {
  const configPath = tempConfigFile(t, JSON.stringify({
    events: {
      trip: {
        group: '123',
        tag: 'ev-trip',
        start: '2026-01-01',
        debtors: { alex: { patterns: ['(?P<name>alex)'] } },
      },
    },
  }));
  const result = runScriptFixture(t, 'event-collect.js', {
    configPath,
    env: { COLLECTION_EVENT: 'trip', FIX_DATA_DIR: '/tmp/darkfinances-regex-test' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Operator regex configuration is invalid/);
  assert.doesNotMatch(result.stderr, /init-should-not-run/);
  assert.doesNotMatch(result.stderr, /splitwise-should-not-run/);
});

test('build-rules rejects invalid skipPatterns before Actual init', (t) => {
  const configPath = tempConfigFile(t, JSON.stringify({ skipPatterns: ['(a+)+$'] }));
  const result = runScriptFixture(t, 'build-rules.js', {
    configPath,
    env: { FIX_DATA_DIR: '/tmp/darkfinances-regex-test' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Operator regex configuration is invalid/);
  assert.doesNotMatch(result.stderr, /init-should-not-run/);
});

test('loadCollectionRule accepts a valid private rules file', (t) => {
  const configPath = tempConfigFile(t, JSON.stringify({
    events: {
      trip: {
        group: '123',
        tag: 'ev-trip',
        start: '2026-01-01',
        debtors: { alex: { patterns: ['\\balex\\b'] } },
      },
    },
  }));
  const rule = loadCollectionRule(configPath, 'trip');
  assert.equal(rule.tag, 'ev-trip');
});

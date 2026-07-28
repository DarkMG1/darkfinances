'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deriveClosureLockPaths,
  enumerateNodeModulesRoots,
  resolveLockDependency,
  resolveLockDependencyCandidates,
} = require('../../finance-dashboard/lib/eas-cli-runtime-closure');

const repositoryRoot = require('path').resolve(__dirname, '..', '..');
const lock = require(require('path').join(repositoryRoot, 'ops/publisher-toolchain/package-lock.json'));

const RESOLVE_TABLE = [
  {
    label: 'top-level hoisted dependency from eas-cli',
    from: 'node_modules/eas-cli',
    dep: '@oclif/core',
    expected: 'node_modules/@oclif/core',
  },
  {
    label: 'top-level hoisted unscoped dependency from eas-cli',
    from: 'node_modules/eas-cli',
    dep: 'chalk',
    expected: 'node_modules/chalk',
  },
  {
    label: 'nested package prefers local child node_modules',
    from: 'node_modules/@oclif/plugin-autocomplete',
    dep: '@oclif/core',
    expected: 'node_modules/@oclif/core',
  },
  {
    label: 'scoped top-level package',
    from: 'node_modules/@oclif/core',
    dep: 'fs-extra',
    expected: 'node_modules/fs-extra',
  },
];

test('enumerateNodeModulesRoots walks deepest enclosing node_modules roots', () => {
  assert.deepEqual(
    enumerateNodeModulesRoots('node_modules/eas-cli'),
    ['node_modules/eas-cli', ''],
  );
  assert.deepEqual(
    enumerateNodeModulesRoots('node_modules/a/node_modules/b'),
    ['node_modules/a/node_modules/b', 'node_modules/a', ''],
  );
  assert.deepEqual(enumerateNodeModulesRoots('node_modules/@scope/pkg'), ['node_modules/@scope/pkg', '']);
});

test('resolveLockDependencyCandidates preserve npm ancestor search order', () => {
  assert.deepEqual(
    resolveLockDependencyCandidates('node_modules/eas-cli', '@oclif/core'),
    [
      'node_modules/eas-cli/node_modules/@oclif/core',
      'node_modules/@oclif/core',
    ],
  );
  assert.deepEqual(
    resolveLockDependencyCandidates('node_modules/a/node_modules/b', 'dep'),
    [
      'node_modules/a/node_modules/b/node_modules/dep',
      'node_modules/a/node_modules/dep',
      'node_modules/dep',
    ],
  );
});

for (const entry of RESOLVE_TABLE) {
  test(`resolveLockDependency: ${entry.label}`, () => {
    assert.equal(resolveLockDependency(entry.from, entry.dep, lock), entry.expected);
  });
}

test('deriveClosureLockPaths includes hoisted @oclif/core and resolves all eas-cli dependencies', () => {
  const closure = deriveClosureLockPaths(lock);
  assert.ok(closure.includes('node_modules/@oclif/core'));
  assert.ok(closure.includes('node_modules/eas-cli'));
  assert.equal(closure.length, 510);
  const eas = lock.packages['node_modules/eas-cli'];
  for (const depName of Object.keys(eas.dependencies || {})) {
    const resolved = resolveLockDependency('node_modules/eas-cli', depName, lock);
    assert.ok(resolved, `expected required dependency ${depName} to resolve`);
    assert.ok(closure.includes(resolved), `expected closure to include ${resolved} for ${depName}`);
  }
});

test('deriveClosureLockPaths fails when required dependency cannot resolve', () => {
  const broken = {
    packages: {
      'node_modules/eas-cli': {
        version: '1.0.0',
        dependencies: { missing: '1.0.0' },
      },
    },
  };
  assert.throws(
    () => deriveClosureLockPaths(broken),
    /required dependency missing of node_modules\/eas-cli is unresolved in lockfile/,
  );
});

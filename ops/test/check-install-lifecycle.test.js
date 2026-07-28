'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  checkBetterSqlite3,
  checkInstallLifecycle,
  checkUnrsResolver,
  findUnrsNativeBinding,
} = require('../../scripts/check-install-lifecycle');
const { checkAppInstallLifecycle } = require('../../finance-app/scripts/check-app-install-lifecycle');

const repositoryRoot = path.resolve(__dirname, '..', '..');

test('checkInstallLifecycle loads better-sqlite3 and unrs-resolver bindings', () => {
  const result = checkInstallLifecycle({ root: repositoryRoot });
  assert.deepEqual(result.modules, ['better-sqlite3', 'unrs-resolver']);
});

test('checkBetterSqlite3 fails when native binding is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-lifecycle-'));
  const moduleRoot = path.join(root, 'node_modules', 'better-sqlite3');
  fs.mkdirSync(path.join(moduleRoot, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(moduleRoot, 'build', 'Release'), { recursive: true });
  fs.writeFileSync(path.join(moduleRoot, 'package.json'), JSON.stringify({
    name: 'better-sqlite3',
    version: '0.0.0',
    main: 'lib/index.js',
  }));
  fs.writeFileSync(path.join(moduleRoot, 'lib', 'index.js'), 'throw new Error("should not load");');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  assert.throws(() => checkBetterSqlite3(root), /native binding missing/);
});

test('checkUnrsResolver stub sync without native binding fails closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-lifecycle-'));
  const moduleRoot = path.join(root, 'node_modules', 'unrs-resolver');
  fs.mkdirSync(moduleRoot, { recursive: true });
  fs.writeFileSync(path.join(moduleRoot, 'package.json'), JSON.stringify({
    name: 'unrs-resolver',
    version: '0.0.0',
    main: 'index.js',
  }));
  fs.writeFileSync(
    path.join(moduleRoot, 'index.js'),
    'module.exports = { sync: () => ({ path: require("path").join(process.cwd(), "package.json") }) };',
  );
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  assert.throws(() => checkUnrsResolver(root), /native binding .node artifact missing/);
});

test('checkAppInstallLifecycle requires local finance-app unrs-resolver', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-install-lifecycle-'));
  const appRoot = path.join(root, 'finance-app');
  fs.mkdirSync(appRoot, { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'finance-app', version: '1.0.0' }));
  assert.throws(
    () => checkAppInstallLifecycle({ root: appRoot }),
    /unrs-resolver missing under .*finance-app\/node_modules/,
  );
});

test('checkUnrsResolver fails when sync API is unavailable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-lifecycle-'));
  const moduleRoot = path.join(root, 'node_modules', 'unrs-resolver');
  fs.mkdirSync(moduleRoot, { recursive: true });
  fs.writeFileSync(path.join(moduleRoot, 'package.json'), JSON.stringify({
    name: 'unrs-resolver',
    version: '0.0.0',
    main: 'index.js',
  }));
  fs.writeFileSync(path.join(moduleRoot, 'index.js'), 'module.exports = {};');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  assert.throws(() => checkUnrsResolver(root), /native binding .node artifact missing|sync API is unavailable/);
});

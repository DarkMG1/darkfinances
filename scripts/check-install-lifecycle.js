#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const ROOT = path.resolve(__dirname, '..');

function resolveModuleRoot(moduleName, searchRoot = ROOT, { localOnly = false } = {}) {
  const localPackageJson = path.join(searchRoot, 'node_modules', moduleName, 'package.json');
  if (localOnly) {
    if (!fs.existsSync(localPackageJson)) {
      throw new Error(`${moduleName} missing under ${searchRoot}/node_modules`);
    }
    return path.dirname(localPackageJson);
  }
  const requireFromRoot = createRequire(path.join(searchRoot, 'package.json'));
  const resolved = requireFromRoot.resolve(moduleName);
  let current = path.dirname(resolved);
  while (true) {
    const candidate = path.join(current, 'package.json');
    if (fs.existsSync(candidate)) {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (pkg.name === moduleName) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`unable to locate ${moduleName} package root from ${searchRoot}`);
}

function findUnrsNativeBinding(moduleRoot, searchRoot) {
  for (const name of fs.readdirSync(moduleRoot)) {
    if (!name.endsWith('.node')) continue;
    const candidate = path.join(moduleRoot, name);
    if (fs.statSync(candidate).isFile()) return candidate;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'package.json'), 'utf8'));
  const requireFrom = createRequire(path.join(searchRoot, 'package.json'));
  for (const dep of Object.keys(pkg.optionalDependencies || {})) {
    if (!dep.startsWith('@unrs/resolver-binding-')) continue;
    try {
      const depRoot = path.dirname(requireFrom.resolve(`${dep}/package.json`));
      for (const name of fs.readdirSync(depRoot)) {
        if (!name.endsWith('.node')) continue;
        const candidate = path.join(depRoot, name);
        if (fs.statSync(candidate).isFile()) return candidate;
      }
    } catch {
      // optional binding not installed on this platform
    }
  }
  return null;
}

function checkBetterSqlite3(searchRoot = ROOT) {
  const moduleRoot = resolveModuleRoot('better-sqlite3', searchRoot);
  const bindingCandidates = [
    path.join(moduleRoot, 'build', 'Release', 'better_sqlite3.node'),
    path.join(moduleRoot, 'build', 'Debug', 'better_sqlite3.node'),
  ];
  if (!bindingCandidates.some((candidate) => fs.existsSync(candidate))) {
    throw new Error(
      `better-sqlite3 native binding missing under ${moduleRoot}; run npm ci without --ignore-scripts`,
    );
  }
  const Database = createRequire(path.join(searchRoot, 'package.json'))('better-sqlite3');
  const db = new Database(':memory:');
  try {
    const row = db.prepare('SELECT 1 AS ok').get();
    if (!row || row.ok !== 1) throw new Error('better-sqlite3 query returned unexpected result');
  } finally {
    db.close();
  }
}

function checkUnrsResolver(searchRoot = ROOT, { localOnly = false } = {}) {
  const moduleRoot = resolveModuleRoot('unrs-resolver', searchRoot, { localOnly });
  const bindingPath = findUnrsNativeBinding(moduleRoot, searchRoot);
  if (!bindingPath) {
    throw new Error(`unrs-resolver native binding .node artifact missing under ${moduleRoot}`);
  }
  const resolver = createRequire(path.join(searchRoot, 'package.json'))('unrs-resolver');
  if (typeof resolver.sync !== 'function') {
    throw new Error('unrs-resolver sync API is unavailable; native/postinstall output may be broken');
  }
  const resolved = resolver.sync(process.cwd(), './package.json');
  const resolvedPath = typeof resolved === 'string' ? resolved : resolved?.path;
  if (typeof resolvedPath !== 'string' || !resolvedPath.endsWith('package.json')) {
    throw new Error(`unrs-resolver sync returned unexpected path: ${JSON.stringify(resolved)}`);
  }
  return bindingPath;
}

function checkInstallLifecycle({ root = ROOT } = {}) {
  checkBetterSqlite3(root);
  checkUnrsResolver(root);
  return {
    root,
    modules: ['better-sqlite3', 'unrs-resolver'],
  };
}

function main() {
  try {
    const result = checkInstallLifecycle();
    console.log(`install-lifecycle: ok (${result.modules.join(', ')})`);
  } catch (error) {
    console.error(`install-lifecycle: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = {
  checkBetterSqlite3,
  checkInstallLifecycle,
  checkUnrsResolver,
  findUnrsNativeBinding,
  resolveModuleRoot,
};

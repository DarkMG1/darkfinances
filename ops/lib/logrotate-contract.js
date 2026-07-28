'use strict';

const fs = require('fs');
const path = require('path');

const CONTRACT_PATH = path.join(__dirname, 'logrotate-contract.json');
const CONTRACT_KIND = 'darkfinances-logrotate-contract';
const LOGROTATE_CONFIG_PATH = path.join(__dirname, '..', 'logrotate-darkfinances.conf');
const DIRECTIVE_PATTERN = /^\s*([A-Za-z]+(?:\s+\d+[A-Za-z]+)?)\b/;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function loadLogrotateContract(options = {}) {
  const contractPath = options.contractPath || CONTRACT_PATH;
  const stat = fs.lstatSync(contractPath);
  if (stat.isSymbolicLink()) throw new Error('logrotate contract must not be a symbolic link');
  if (!stat.isFile()) throw new Error('logrotate contract must be a regular file');

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  } catch (error) {
    throw new Error(`logrotate contract is not valid JSON: ${error.message}`);
  }

  if (!isPlainObject(parsed)) throw new Error('logrotate contract must be a JSON object');
  if (parsed.kind !== CONTRACT_KIND) throw new Error('logrotate contract kind mismatch');
  if (parsed.schemaVersion !== 1) {
    throw new Error(`unsupported logrotate contract schemaVersion ${parsed.schemaVersion}`);
  }
  if (parsed.authoritativeLogging !== 'journald') {
    throw new Error('logrotate contract authoritativeLogging must be journald');
  }
  if (!isPlainObject(parsed.rotation)) throw new Error('logrotate contract requires rotation');
  if (parsed.rotation.strategy !== 'rename-create') {
    throw new Error('logrotate contract rotation.strategy must be rename-create');
  }
  if (!Array.isArray(parsed.rotation.forbiddenDirectives) || parsed.rotation.forbiddenDirectives.length === 0) {
    throw new Error('logrotate contract requires rotation.forbiddenDirectives');
  }
  if (parsed.rotation.createMode !== '0600') {
    throw new Error('logrotate contract rotation.createMode must be 0600');
  }
  if (typeof parsed.rotation.runAsUser !== 'string' || !parsed.rotation.runAsUser) {
    throw new Error('logrotate contract rotation.runAsUser is required');
  }
  if (typeof parsed.rotation.runAsGroup !== 'string' || !parsed.rotation.runAsGroup) {
    throw new Error('logrotate contract rotation.runAsGroup is required');
  }
  if (!Array.isArray(parsed.paths) || parsed.paths.length === 0) {
    throw new Error('logrotate contract requires paths');
  }
  if (!Array.isArray(parsed.reviewedJournalUnits) || parsed.reviewedJournalUnits.length === 0) {
    throw new Error('logrotate contract requires reviewedJournalUnits');
  }

  const ids = new Set();
  for (const entry of parsed.paths) {
    if (!isPlainObject(entry)) throw new Error('logrotate contract path entry must be an object');
    if (typeof entry.id !== 'string' || !entry.id) {
      throw new Error('logrotate contract path entry requires id');
    }
    if (ids.has(entry.id)) throw new Error(`duplicate logrotate contract path id: ${entry.id}`);
    ids.add(entry.id);
    if (typeof entry.pattern !== 'string' || !entry.pattern.startsWith('/')) {
      throw new Error(`logrotate contract path ${entry.id} pattern must be absolute`);
    }
    if (entry.longRunningFileDescriptor !== false) {
      throw new Error(`logrotate contract path ${entry.id} must declare longRunningFileDescriptor=false`);
    }
    if (entry.reviewedLogging !== 'journald') {
      throw new Error(`logrotate contract path ${entry.id} reviewedLogging must be journald`);
    }
  }

  return parsed;
}

function readLogrotateConfig(options = {}) {
  const configPath = options.configPath || LOGROTATE_CONFIG_PATH;
  return fs.readFileSync(configPath, 'utf8');
}

function parseLogrotateDirectives(configText) {
  const directives = [];
  for (const line of configText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('{') || trimmed.startsWith('}')) {
      continue;
    }
    const match = trimmed.match(DIRECTIVE_PATTERN);
    if (!match) continue;
    directives.push(match[1].toLowerCase());
  }
  return directives;
}

function parseLogrotatePathHeader(configText) {
  const headerLine = configText
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && line.endsWith('{'));
  if (!headerLine) throw new Error('logrotate config missing path header');
  return headerLine.slice(0, -1).trim();
}

function parseLogrotateSuDirectives(configText) {
  const matches = [];
  for (const line of configText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^su\s+(\S+)\s+(\S+)\s*$/i);
    if (match) {
      matches.push({ user: match[1], group: match[2], line: trimmed });
    }
  }
  return matches;
}

function parseLogrotateCreateDirectives(configText) {
  const matches = [];
  for (const line of configText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^create\s+(\S+)\s+(\S+)\s+(\S+)\s*$/i);
    if (match) {
      matches.push({ mode: match[1], user: match[2], group: match[3], line: trimmed });
    }
  }
  return matches;
}

function validateOwnershipDirectives(configText, contract) {
  const suDirectives = parseLogrotateSuDirectives(configText);
  const createDirectives = parseLogrotateCreateDirectives(configText);
  const expectedUser = contract.rotation.runAsUser;
  const expectedGroup = contract.rotation.runAsGroup;
  const expectedMode = contract.rotation.createMode;

  if (suDirectives.length !== 1) {
    throw new Error(`logrotate config must declare exactly one su directive, found ${suDirectives.length}`);
  }
  if (createDirectives.length !== 1) {
    throw new Error(`logrotate config must declare exactly one create directive, found ${createDirectives.length}`);
  }

  const su = suDirectives[0];
  const create = createDirectives[0];

  if (su.user !== expectedUser || su.group !== expectedGroup) {
    throw new Error(
      `logrotate su mismatch: expected su ${expectedUser} ${expectedGroup}, got ${su.line}`,
    );
  }
  if (create.mode !== expectedMode) {
    throw new Error(`logrotate create mode mismatch: expected ${expectedMode}, got ${create.mode}`);
  }
  if (create.user !== expectedUser || create.group !== expectedGroup) {
    throw new Error(
      `logrotate create ownership mismatch: expected ${expectedMode} ${expectedUser} ${expectedGroup}, got ${create.line}`,
    );
  }
  if (create.user !== su.user || create.group !== su.group) {
    throw new Error('logrotate create ownership must exactly match su ownership');
  }

  return { su, create };
}

function validateLogrotateConfigAgainstContract(options = {}) {
  const contract = loadLogrotateContract(options);
  const configText = readLogrotateConfig(options);
  const directives = parseLogrotateDirectives(configText);
  const pathHeader = parseLogrotatePathHeader(configText);
  const expectedPatterns = contract.paths.map((entry) => entry.pattern).sort();
  const actualPatterns = pathHeader.split(/\s+/).sort();

  if (JSON.stringify(actualPatterns) !== JSON.stringify(expectedPatterns)) {
    throw new Error(
      `logrotate path header mismatch: expected ${expectedPatterns.join(' ')}, got ${pathHeader}`,
    );
  }

  for (const forbidden of contract.rotation.forbiddenDirectives) {
    if (directives.includes(forbidden.toLowerCase())) {
      throw new Error(`logrotate config must not use forbidden directive: ${forbidden}`);
    }
  }

  const ownership = validateOwnershipDirectives(configText, contract);

  return {
    contract,
    configText,
    directives,
    pathHeader,
    ownership,
  };
}

module.exports = {
  CONTRACT_PATH,
  LOGROTATE_CONFIG_PATH,
  loadLogrotateContract,
  readLogrotateConfig,
  parseLogrotateDirectives,
  parseLogrotatePathHeader,
  parseLogrotateSuDirectives,
  parseLogrotateCreateDirectives,
  validateOwnershipDirectives,
  validateLogrotateConfigAgainstContract,
};

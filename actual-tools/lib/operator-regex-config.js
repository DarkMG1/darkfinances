'use strict';

const fs = require('fs');
const safe = require('safe-regex2');

const CONFIG_ERROR_CODE = 'OPERATOR_REGEX_CONFIG_INVALID';

const DEFAULT_LIMITS = Object.freeze({
  maxPatternsPerSet: 32,
  maxPatternLength: 256,
  maxAggregatePatternLength: 4096,
  maxPatternSets: 64,
  maxSkipNames: 256,
  maxSkipNameLength: 256,
  maxSkipNamesAggregateLength: 4096,
  defaultFlags: 'i',
  allowedFlags: new Set(['', 'i']),
});

class OperatorRegexConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OperatorRegexConfigError';
    this.code = CONFIG_ERROR_CODE;
  }
}

function configError(detail) {
  return new OperatorRegexConfigError(`Operator regex configuration is invalid: ${detail}`);
}

function compileValidatedSource(source, flags, { setLabel, index }) {
  if (!DEFAULT_LIMITS.allowedFlags.has(flags)) {
    throw configError(`${setLabel} uses disallowed regex flags`);
  }
  let regex;
  try {
    regex = new RegExp(source, flags);
  } catch (_) {
    throw configError(`pattern at index ${index} in ${setLabel} has invalid syntax`);
  }
  if (!safe(regex)) {
    throw configError(`pattern at index ${index} in ${setLabel} is not safe`);
  }
  if (regex.test('')) {
    throw configError(`pattern at index ${index} in ${setLabel} must not match empty input`);
  }
  return regex;
}

function validateSkipNames(skipNames, limits = DEFAULT_LIMITS) {
  if (skipNames === undefined) return;
  if (!Array.isArray(skipNames)) {
    throw configError('skipNames must be an array');
  }
  if (skipNames.length > limits.maxSkipNames) {
    throw configError('skipNames exceeds maximum entry count');
  }
  let aggregateLength = 0;
  for (let index = 0; index < skipNames.length; index++) {
    const entry = skipNames[index];
    if (typeof entry !== 'string') {
      throw configError(`skipNames entry at index ${index} must be a string`);
    }
    if (!entry.length) {
      throw configError(`skipNames entry at index ${index} must be non-empty`);
    }
    if (entry.length > limits.maxSkipNameLength) {
      throw configError(`skipNames entry at index ${index} exceeds maximum length`);
    }
    aggregateLength += entry.length;
    if (aggregateLength > limits.maxSkipNamesAggregateLength) {
      throw configError('skipNames aggregate length exceeds maximum');
    }
  }
}

function validatePatternSources(sources, { setLabel, limits = DEFAULT_LIMITS, flags = limits.defaultFlags }) {
  if (!Array.isArray(sources)) {
    throw configError(`${setLabel} patterns must be an array`);
  }
  if (!sources.length) {
    throw configError(`${setLabel} requires at least one pattern`);
  }
  if (sources.length > limits.maxPatternsPerSet) {
    throw configError(`${setLabel} exceeds maximum pattern count`);
  }

  const validated = [];
  let aggregateLength = 0;
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    if (typeof source !== 'string') {
      throw configError(`pattern at index ${index} in ${setLabel} must be a string`);
    }
    if (!source.length) {
      throw configError(`pattern at index ${index} in ${setLabel} must be non-empty`);
    }
    if (source.length > limits.maxPatternLength) {
      throw configError(`pattern at index ${index} in ${setLabel} exceeds maximum length`);
    }
    aggregateLength += source.length;
    if (aggregateLength > limits.maxAggregatePatternLength) {
      throw configError(`${setLabel} aggregate pattern length exceeds maximum`);
    }
    validated.push({
      source,
      regex: compileValidatedSource(source, flags, { setLabel, index }),
    });
  }
  return validated;
}

function compilePatternList(sources, { setLabel, flags = DEFAULT_LIMITS.defaultFlags, limits = DEFAULT_LIMITS } = {}) {
  return validatePatternSources(sources, { setLabel, limits, flags }).map((entry) => entry.regex);
}

function compilePatternUnion(sources, { setLabel, flags = DEFAULT_LIMITS.defaultFlags, limits = DEFAULT_LIMITS } = {}) {
  const validated = validatePatternSources(sources, { setLabel, limits, flags });
  const combined = validated.map((entry) => `(?:${entry.source})`).join('|');
  if (combined.length > limits.maxAggregatePatternLength) {
    throw configError(`${setLabel} combined pattern exceeds maximum length`);
  }
  return compileValidatedSource(combined, flags, { setLabel, index: 0 });
}

function validateBuildRulesConfig(raw) {
  if (raw === undefined || raw === null) {
    return { skipNames: new Set(), skipPatterns: [] };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw configError('build-rules configuration must be an object');
  }

  const { skipNames, skipPatterns } = raw;
  validateSkipNames(skipNames);
  if (skipPatterns !== undefined) {
    validatePatternSources(skipPatterns, { setLabel: 'skipPatterns' });
  }

  return {
    skipNames: new Set(Array.isArray(skipNames) ? skipNames : []),
    skipPatterns: Array.isArray(skipPatterns) ? skipPatterns : [],
  };
}

function loadBuildRulesConfig(filePath, fsModule = fs) {
  if (!fsModule.existsSync(filePath)) {
    return validateBuildRulesConfig(null);
  }
  let parsed;
  try {
    parsed = JSON.parse(fsModule.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw configError('build-rules configuration is not valid JSON');
    }
    throw error;
  }
  return validateBuildRulesConfig(parsed);
}

function validateCollectionRule(rule, { eventName, limits = DEFAULT_LIMITS } = {}) {
  if (!rule || typeof rule !== 'object') {
    throw configError('collection rule is incomplete');
  }
  if (!rule.group || !rule.tag || !rule.start || !rule.debtors) {
    throw configError('collection rule is incomplete');
  }
  if (typeof rule.debtors !== 'object' || Array.isArray(rule.debtors)) {
    throw configError('collection rule debtors must be an object');
  }

  const slugs = Object.keys(rule.debtors);
  if (!slugs.length) {
    throw configError('collection rule requires debtors');
  }
  if (slugs.length > limits.maxPatternSets) {
    throw configError('collection rule exceeds maximum debtor count');
  }

  for (const slug of slugs) {
    const debtor = rule.debtors[slug];
    if (!debtor || typeof debtor !== 'object') {
      throw configError('debtor configuration is invalid');
    }
    validatePatternSources(debtor.patterns, { setLabel: `debtor ${slug}`, limits });
    compilePatternUnion(debtor.patterns, { setLabel: `debtor ${slug}`, limits });
  }

  if (eventName) {
    return { ...rule, eventName };
  }
  return rule;
}

function readCollectionRule(config, eventName, options = {}) {
  if (!eventName) {
    throw configError('collection event is required');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw configError('collection rules configuration must be an object');
  }
  const rule = config.events?.[eventName];
  if (!rule) {
    throw configError('no collection rule configured for event');
  }
  return validateCollectionRule(rule, { ...options, eventName });
}

function loadCollectionRule(configPath, eventName, fsModule = fs) {
  if (!eventName) {
    throw configError('collection event is required');
  }
  let parsed;
  try {
    parsed = JSON.parse(fsModule.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw configError('collection rules configuration is not valid JSON');
    }
    throw error;
  }
  return readCollectionRule(parsed, eventName);
}

function compileCollectionDebtors(rule, routed, options = {}) {
  const debtors = {};
  for (const [slug, value] of Object.entries(rule.debtors)) {
    const expected = routed.find((person) => person.slug === slug)?.amount || 0;
    debtors[slug] = {
      expectedCents: Math.round(expected * 100),
      regex: compilePatternUnion(value.patterns, { setLabel: `debtor ${slug}`, ...options }),
    };
  }
  return debtors;
}

module.exports = {
  CONFIG_ERROR_CODE,
  DEFAULT_LIMITS,
  OperatorRegexConfigError,
  compileCollectionDebtors,
  compilePatternList,
  compilePatternUnion,
  loadBuildRulesConfig,
  loadCollectionRule,
  readCollectionRule,
  validateBuildRulesConfig,
  validateCollectionRule,
  validatePatternSources,
  validateSkipNames,
};

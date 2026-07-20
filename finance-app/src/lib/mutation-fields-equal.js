const { canonicalJson } = require('./request-operation-state');

function mutationFieldsEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) || Array.isArray(b)) return canonicalJson(a) === canonicalJson(b);
  return canonicalJson(a) === canonicalJson(b);
}

module.exports = {
  mutationFieldsEqual,
};

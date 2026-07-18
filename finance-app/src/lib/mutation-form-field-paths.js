/** Request-contract issue paths → mobile form field keys (PR-37 / PR-29). */

const DEFAULT_PATH_MAP = Object.freeze({
  amount: 'amount',
  date: 'date',
  payee: 'payee',
  notes: 'notes',
  categoryId: 'categoryId',
  accountId: 'accountId',
  match: 'match',
  name: 'name',
  target: 'target',
  current: 'current',
  deadline: 'deadline',
  month: 'month',
  start: 'start',
  members: 'members',
  group: 'group',
  allocationCents: 'allocationCents',
  imageBase64: 'imageBase64',
  mime: 'mime',
  value: 'value',
  kind: 'kind',
  reconciled: 'reconciled',
  done: 'done',
  status: 'status',
  hidden: 'hidden',
  isBill: 'isBill',
  forced: 'forced',
  body: 'request',
  query: 'request',
  request: 'request',
});

/** Screen-specific contract path → form field aliases (inventory for tests). */
const FORM_SCREEN_PATH_OVERRIDES = Object.freeze({
  budgets: Object.freeze({ amount: 'targetText' }),
  'transaction-link': Object.freeze({ allocationCents: 'allocationCents' }),
});

const SENSITIVE_PATH = /base64|secret|token|password|authorization|image/i;

function normalizeContractPath(path) {
  const raw = String(path || '').trim();
  if (!raw || raw === 'body' || raw === 'query') return 'request';
  const top = raw.split(/[.[\]]+/).filter(Boolean)[0] || 'request';
  if (SENSITIVE_PATH.test(top)) return 'request';
  return top;
}

function mapContractPathToField(path, overrides = {}) {
  const raw = String(path || '').trim();
  if (overrides[path]) return overrides[path];
  const legMatch = /^legs(?:\.|\[)(\d+)/.exec(raw);
  if (legMatch) {
    const idx = Number(legMatch[1]);
    if (overrides[`leg-${idx}`]) return overrides[`leg-${idx}`];
    return `leg-${idx}`;
  }
  const top = normalizeContractPath(path);
  if (overrides[top]) return overrides[top];
  return DEFAULT_PATH_MAP[top] || top;
}

function mapContractIssuesToFieldErrors(issues, overrides = {}) {
  const fieldErrors = Object.create(null);
  if (!Array.isArray(issues)) return fieldErrors;
  for (const issue of issues) {
    if (!issue || typeof issue.message !== 'string') continue;
    const field = mapContractPathToField(issue.path, overrides);
    if (!fieldErrors[field]) fieldErrors[field] = issue.message;
  }
  return fieldErrors;
}

function firstInvalidField(fieldErrors, fieldOrder = []) {
  for (const field of fieldOrder) {
    if (fieldErrors[field]) return field;
  }
  const keys = Object.keys(fieldErrors);
  return keys.length ? keys[0] : null;
}

module.exports = {
  DEFAULT_PATH_MAP,
  FORM_SCREEN_PATH_OVERRIDES,
  firstInvalidField,
  mapContractIssuesToFieldErrors,
  mapContractPathToField,
  normalizeContractPath,
};

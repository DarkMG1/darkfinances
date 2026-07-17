const DEFAULT_FINANCE_TIME_ZONE = 'America/Los_Angeles';

function isValidIanaTimeZone(zone) {
  if (typeof zone !== 'string' || !zone.trim()) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: zone.trim() }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function resolveFinanceTimeZone(options = {}) {
  const candidates = [
    options.financeTimeZone ?? process.env.FINANCE_TIME_ZONE,
    options.tz ?? process.env.TZ,
    options.fallback ?? DEFAULT_FINANCE_TIME_ZONE,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (isValidIanaTimeZone(trimmed)) return trimmed;
  }
  return DEFAULT_FINANCE_TIME_ZONE;
}

function createFinanceDateFormatter(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

const FINANCE_TIME_ZONE = resolveFinanceTimeZone();
const financeDateFormatter = createFinanceDateFormatter(FINANCE_TIME_ZONE);

function todayYMD(value = new Date()) {
  return financeDateFormatter.format(value);
}

function parseYMD(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) throw new Error('date must be YYYY-MM-DD');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('date must be a real calendar date');
  }
  return { year, month, day, date };
}

function formatUTCDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addDays(value, count) {
  const { date } = parseYMD(value);
  date.setUTCDate(date.getUTCDate() + Number(count));
  return formatUTCDate(date);
}

module.exports = {
  DEFAULT_FINANCE_TIME_ZONE,
  FINANCE_TIME_ZONE,
  addDays,
  isValidIanaTimeZone,
  parseYMD,
  resolveFinanceTimeZone,
  todayYMD,
};

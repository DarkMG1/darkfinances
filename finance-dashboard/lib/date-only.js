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
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

const FINANCE_TIME_ZONE = resolveFinanceTimeZone();
let financeDateFormatter = createFinanceDateFormatter(FINANCE_TIME_ZONE);

function parts(value, formatter = financeDateFormatter) {
  return Object.fromEntries(
    formatter.formatToParts(value).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  );
}

function todayYMD(value = new Date(), timeZone = FINANCE_TIME_ZONE) {
  const formatter = timeZone === FINANCE_TIME_ZONE
    ? financeDateFormatter
    : createFinanceDateFormatter(timeZone);
  const { year, month, day } = parts(value, formatter);
  return `${year}-${month}-${day}`;
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

function isDateOnly(value) {
  try {
    parseYMD(value);
    return true;
  } catch {
    return false;
  }
}

function formatUTCDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addDays(value, count) {
  const { date } = parseYMD(value);
  date.setUTCDate(date.getUTCDate() + Number(count));
  return formatUTCDate(date);
}

function addMonths(value, count) {
  const { year, month, day } = parseYMD(value);
  const targetFirst = new Date(Date.UTC(year, month - 1 + Number(count), 1));
  const targetYear = targetFirst.getUTCFullYear();
  const targetMonth = targetFirst.getUTCMonth();
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return formatUTCDate(new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay))));
}

function daysBetween(start, end) {
  const a = parseYMD(start).date.getTime();
  const b = parseYMD(end).date.getTime();
  return Math.round((b - a) / 86_400_000);
}

function daysUntilDateOnly(target, anchor = todayYMD()) {
  return daysBetween(anchor, target);
}

function monthStart(value) {
  const { year, month } = parseYMD(value);
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

function monthRange(year, monthIndex) {
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 0));
  const key = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  return { key, start: formatUTCDate(start), end: formatUTCDate(end) };
}

function daysInMonth(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!match) throw new Error('month must be YYYY-MM');
  return new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
}

function monthEnd(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!match) throw new Error('month must be YYYY-MM');
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${year}-${String(monthNumber).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

function shiftMonth(month, count) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!match) throw new Error('month must be YYYY-MM');
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const date = new Date(Date.UTC(year, monthNumber - 1 + Number(count), 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function startMonthsAgo(months, anchor = todayYMD()) {
  const month = anchor.slice(0, 7);
  return `${shiftMonth(month, -(Number(months) - 1))}-01`;
}

function reimbursementWindow(range, anchor = todayYMD()) {
  const to = anchor;
  if (range === 'mtd') return { from: monthStart(anchor), to, label: 'This month' };
  if (range === '7d') return { from: addDays(anchor, -6), to, label: 'Last 7 days' };
  if (range === '30d') return { from: addDays(anchor, -29), to, label: 'Last 30 days' };
  return { label: 'Lifetime' };
}

module.exports = {
  DEFAULT_FINANCE_TIME_ZONE,
  FINANCE_TIME_ZONE,
  addDays,
  addMonths,
  daysBetween,
  daysInMonth,
  daysUntilDateOnly,
  isDateOnly,
  isValidIanaTimeZone,
  monthEnd,
  monthRange,
  monthStart,
  parseYMD,
  reimbursementWindow,
  resolveFinanceTimeZone,
  shiftMonth,
  startMonthsAgo,
  todayYMD,
};

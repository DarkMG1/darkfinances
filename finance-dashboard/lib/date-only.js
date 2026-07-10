const FINANCE_TIME_ZONE = process.env.FINANCE_TIME_ZONE || process.env.TZ || 'America/Los_Angeles';
const financeDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: FINANCE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function parts(value) {
  return Object.fromEntries(
    financeDateFormatter.formatToParts(value).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  );
}

function todayYMD(value = new Date()) {
  const { year, month, day } = parts(value);
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

module.exports = {
  FINANCE_TIME_ZONE,
  addDays,
  addMonths,
  daysBetween,
  daysInMonth,
  monthRange,
  parseYMD,
  todayYMD,
};

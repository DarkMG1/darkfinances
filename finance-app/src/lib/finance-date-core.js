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

function resolveFinanceTimeZone(zone) {
  return isValidIanaTimeZone(zone) ? zone.trim() : DEFAULT_FINANCE_TIME_ZONE;
}

let configuredFinanceTimeZone = DEFAULT_FINANCE_TIME_ZONE;
let financeDateFormatter = createFinanceDateFormatter(configuredFinanceTimeZone);

function createFinanceDateFormatter(timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function configureFinanceTimeZone(zone) {
  configuredFinanceTimeZone = resolveFinanceTimeZone(zone);
  financeDateFormatter = createFinanceDateFormatter(configuredFinanceTimeZone);
  return configuredFinanceTimeZone;
}

function getFinanceTimeZone() {
  return configuredFinanceTimeZone;
}

function financeTodayAt(value = new Date(), timeZone = configuredFinanceTimeZone) {
  const formatter = timeZone === configuredFinanceTimeZone
    ? financeDateFormatter
    : createFinanceDateFormatter(timeZone);
  const parts = Object.fromEntries(
    formatter.formatToParts(value).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function financeToday(value = new Date()) {
  return financeTodayAt(value, configuredFinanceTimeZone);
}

function isDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function addDateOnlyDays(value, count) {
  if (!isDateOnly(value)) throw new Error('Invalid date');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + count));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function daysInMonth(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Invalid month');
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

function monthEnd(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Invalid month');
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber, 0));
  return `${year}-${String(monthNumber).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function shiftMonth(month, count) {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + count, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function previousMonth(month) {
  return shiftMonth(month, -1);
}

function daysBetweenDateOnly(start, end) {
  if (!isDateOnly(start) || !isDateOnly(end)) throw new Error('Invalid date');
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const a = Date.UTC(sy, sm - 1, sd);
  const b = Date.UTC(ey, em - 1, ed);
  return Math.round((b - a) / 86_400_000);
}

function daysUntilDateOnly(target, anchor = financeToday()) {
  return daysBetweenDateOnly(anchor, target);
}

function monthStart(value) {
  if (!isDateOnly(value)) throw new Error('Invalid date');
  return `${value.slice(0, 7)}-01`;
}

function dayOfMonthFromDateOnly(value) {
  if (!isDateOnly(value)) throw new Error('Invalid date');
  return Number(value.slice(8, 10));
}

function startMonthsAgo(months, anchor = financeToday()) {
  const month = anchor.slice(0, 7);
  return `${shiftMonth(month, -(Number(months) - 1))}-01`;
}

function reimbursementWindow(range, anchor = financeToday()) {
  const to = anchor;
  if (range === 'mtd') return { from: monthStart(anchor), to, label: 'This month' };
  if (range === '7d') return { from: addDateOnlyDays(anchor, -6), to, label: 'Last 7 days' };
  if (range === '30d') return { from: addDateOnlyDays(anchor, -29), to, label: 'Last 30 days' };
  return { label: 'Lifetime' };
}

function relativePeriodLabel(start, end, fallback, anchor = financeToday()) {
  const currentMonth = anchor.slice(0, 7);
  const prevMonth = previousMonth(currentMonth);
  const fullMonth = (month, monthStartYmd, monthEndYmd) => {
    const last = monthEnd(month);
    return monthStartYmd === `${month}-01` && (monthEndYmd === last || month === currentMonth);
  };
  const month = start.slice(0, 7);
  if (month === currentMonth && fullMonth(month, start, end)) return 'This month';
  if (month === prevMonth && fullMonth(month, start, end)) return 'Last month';
  return fallback || 'Selected period';
}

function categoryRangeWindow(key, anchor = financeToday()) {
  const end = anchor;
  if (key === 'month') {
    return { start: monthStart(anchor), end, label: 'This month' };
  }
  if (key === '3m') {
    return { start: startMonthsAgo(3, anchor), end, label: 'Last 3 months' };
  }
  if (key === 'year') {
    return { start: `${anchor.slice(0, 4)}-01-01`, end, label: 'This year' };
  }
  return { start: '2000-01-01', end, label: 'All time' };
}

function calendarMonthWindow(month, anchor = financeToday()) {
  const currentMonth = anchor.slice(0, 7);
  const start = `${month}-01`;
  const end = month === currentMonth ? anchor : monthEnd(month);
  return { start, end, label: relativePeriodLabel(start, end, month, anchor) };
}

function sixMonthChartWindow(anchorMonth) {
  const startMonth = shiftMonth(anchorMonth, -5);
  return { start: `${startMonth}-01`, end: monthEnd(anchorMonth) };
}

function monthsThrough(anchorMonth, count = 6) {
  return Array.from({ length: count }, (_, i) => shiftMonth(anchorMonth, -(count - 1 - i)));
}

module.exports = {
  DEFAULT_FINANCE_TIME_ZONE,
  addDateOnlyDays,
  calendarMonthWindow,
  categoryRangeWindow,
  configureFinanceTimeZone,
  dayOfMonthFromDateOnly,
  daysBetweenDateOnly,
  daysInMonth,
  daysUntilDateOnly,
  financeToday,
  financeTodayAt,
  getFinanceTimeZone,
  isDateOnly,
  isValidIanaTimeZone,
  monthEnd,
  monthStart,
  monthsThrough,
  previousMonth,
  relativePeriodLabel,
  reimbursementWindow,
  resolveFinanceTimeZone,
  shiftMonth,
  sixMonthChartWindow,
  startMonthsAgo,
};

import { state } from './state.js';
import { fmtDay } from './format.js';

let financeTimeZone = 'America/Los_Angeles';

export function setFinanceTimeZone(value) {
  if (typeof value === 'string' && value) financeTimeZone = value;
}

export const financeParts = (value = new Date()) => Object.fromEntries(
  new Intl.DateTimeFormat('en-US', {
    timeZone: financeTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]),
);

export const financeToday = () => {
  const { year, month, day } = financeParts();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

export const ymdOrdinal = (d) => {
  const [y, m, day] = d.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, day) / 86400000);
};

export const daysUntil = (d) => {
  if (!d) return null;
  return ymdOrdinal(d) - ymdOrdinal(financeToday());
};

export const dueLabel = (d) => {
  if (!d) return 'date uncertain';
  const n = daysUntil(d);
  if (n < 0) return `${-n}d overdue`;
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n < 14) return `in ${n}d`;
  return fmtDay(d);
};

export function monthBounds() {
  const today = financeToday();
  const [todayYear, todayMonth, todayDay] = today.split('-').map(Number);
  let y; let m;
  if (state.month) {
    [y, m] = state.month.split('-').map(Number);
    m -= 1;
  } else {
    y = todayYear;
    m = todayMonth - 1;
  }
  const start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const isCurrent = y === todayYear && m === todayMonth - 1;
  const endDay = isCurrent ? todayDay : new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const end = `${y}-${String(m + 1).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
  return { start, end };
}

export const monthQS = () => (state.month ? `?month=${state.month}` : '');

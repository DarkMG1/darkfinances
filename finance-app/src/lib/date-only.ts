export type ReimbursementRangeKey = 'mtd' | '7d' | '30d' | 'life';
export type CategoryRangeKey = 'month' | '3m' | 'year' | 'all';

export {
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
} from './finance-date-core.js';

export {
  FinanceDateProvider,
  useEditableFinanceDate,
  useFinanceDate,
  useFinanceToday,
} from '@/state/finance-date';

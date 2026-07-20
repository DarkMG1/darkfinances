export const CATEGORY_COLORS = [
  '#7c6ef7', '#a898ff', '#22c55e', '#eab308', '#ef4444',
  '#06b6d4', '#f97316', '#ec4899', '#8b5cf6', '#14b8a6',
  '#f59e0b', '#6366f1', '#10b981', '#f43f5e', '#3b82f6',
];

export const CATEGORY_COLOR_COUNT = CATEGORY_COLORS.length;

export function categoryColorClass(index) {
  return `cat-color-${Number(index) % CATEGORY_COLOR_COUNT}`;
}

export const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const CADENCE_LABELS = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  semimonthly: 'Twice a month',
  monthly: 'Monthly',
  bimonthly: 'Every 2 months',
  quarterly: 'Quarterly',
  semiannual: 'Every 6 months',
  annual: 'Yearly',
};

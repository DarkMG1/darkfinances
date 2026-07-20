import { MONTH_ABBR, CADENCE_LABELS } from './constants.js';

export const fmt = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtPos = (n) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtK = (n) => {
  const a = Math.abs(n);
  return (n < 0 ? '-$' : '$') + (a >= 1000 ? (a / 1000).toFixed(1) + 'k' : a.toFixed(0));
};

export const formatDate = (d) => {
  const [, m, day] = d.split('-');
  return `${m}/${day}`;
};

export const fmtDay = (d) => {
  if (!d) return '';
  const [, m, day] = d.split('-');
  return `${MONTH_ABBR[+m - 1]} ${+day}`;
};

export const monthLabel = (key) => {
  const [y, m] = key.split('-');
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
};

export const cadenceLabel = (c) => CADENCE_LABELS[c] || c;
export const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export const html = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[ch]);

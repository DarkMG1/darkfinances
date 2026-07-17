// Shared dark palette, mirrors the web dashboard (darkfinances).
import { daysUntilDateOnly } from '@/lib/date-only';

export const colors = {
  bg: '#0a0a0f',
  surface: '#111118',
  surface2: '#18181f',
  border: 'rgba(255,255,255,0.08)',
  text: '#f0f0f5',
  muted: '#6b6b80',
  // Secondary labels (e.g. Not tracked) — matches PR-38 muted for future theme union.
  untrackedLabel: '#9494a8',
  accent: '#7c6ef7',
  accentLight: '#a898ff',
  green: '#22c55e',
  red: '#ef4444',
  yellow: '#eab308',
};

// Category color ramp (matches the web dashboard charts).
export const categoryColors = [
  '#7c6ef7', '#a898ff', '#22c55e', '#eab308', '#ef4444',
  '#06b6d4', '#f97316', '#ec4899', '#8b5cf6', '#14b8a6',
  '#f59e0b', '#6366f1', '#10b981', '#f43f5e', '#3b82f6',
];

export const fmtMoney = (n: number): string => {
  const abs = Math.abs(n);
  return (n < 0 ? '-' : '') + '$' + abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
export const fmtPos = (n: number): string =>
  '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export type MoneyTone = 'goodWhenPositive' | 'badWhenPositive' | 'neutral';
export const fmtSignedMoney = (n: number): string => {
  if (Math.abs(n) < 0.005) return '$0.00';
  return `${n > 0 ? '+' : '-'}${fmtPos(n)}`;
};
export const fmtOutflow = (n: number): string => `-${fmtPos(n)}`;
export const fmtInflow = (n: number): string => `+${fmtPos(n)}`;
export const moneyColor = (n: number, tone: MoneyTone = 'neutral'): string => {
  if (tone === 'neutral' || Math.abs(n) < 0.005) return colors.text;
  if (tone === 'goodWhenPositive') return n >= 0 ? colors.green : colors.red;
  return n > 0 ? colors.red : colors.green;
};
export const fmtK = (n: number): string => {
  const a = Math.abs(n);
  return (n < 0 ? '-$' : '$') + (a >= 1000 ? (a / 1000).toFixed(1) + 'k' : a.toFixed(0));
};
export const fmtDate = (d: string): string => {
  if (!d) return '';
  const [, m, day] = d.split('-');
  return `${m}/${day}`;
};
export const monthLabel = (key: string): string => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
};
export const fmtDay = (d: string): string => {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  if (!y) return d;
  return new Date(y, m - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
export const daysUntil = (d: string, anchor?: string): number => {
  if (!d) return 0;
  return daysUntilDateOnly(d, anchor);
};
export const dueLabel = (d: string, anchor?: string): string => {
  const n = daysUntil(d, anchor);
  if (n < 0) return `${-n}d overdue`;
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n < 14) return `in ${n}d`;
  return fmtDay(d);
};
const CADENCE_LABELS: Record<string, string> = {
  weekly: 'Weekly', biweekly: 'Every 2 weeks', semimonthly: 'Twice a month', monthly: 'Monthly', bimonthly: 'Every 2 months',
  quarterly: 'Quarterly', semiannual: 'Every 6 months', annual: 'Yearly',
};
export const cadenceLabel = (c: string): string => CADENCE_LABELS[c] || c;

// Internal tracking lives as #hashtags in transaction notes (e.g. #ev-trip,
// #alex). Storage stays exactly as-is — automation + the attribution engine rely on
// it — this just splits a note into human-readable text + structured tags so the
// UI can render chips instead of raw "#" noise.
export type NoteTagKind = 'event' | 'tag';
export type NoteTag = { raw: string; label: string; kind: NoteTagKind };
// #ev-* are event rollups; everything else is a generic tag.
export const tagKind = (token: string): NoteTagKind => (/^ev-/i.test(token) ? 'event' : 'tag');
// Normalize free text into a tag token: lowercase, dashed, no leading '#'.
export const toTagToken = (input: string): string =>
  (input || '').trim().toLowerCase().replace(/^#+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const parseNoteTags = (notes?: string): { text: string; tags: NoteTag[] } => {
  const src = notes || '';
  const tags: NoteTag[] = [];
  const re = /#([A-Za-z0-9][\w-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const token = m[1];
    const kind = tagKind(token);
    tags.push({ raw: m[0], label: kind === 'event' ? token.replace(/^ev-/i, '') : token, kind });
  }
  const text = src
    .replace(re, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*\|\s*$/, '')
    .trim();
  return { text, tags };
};

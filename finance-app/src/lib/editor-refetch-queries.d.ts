import type { RefetchQueryEntry } from '@/components/query-display';

export function buildTransactionEditorAuxiliaryRefetchQueries(ctx: {
  categories: RefetchQueryEntry;
  recurring: RefetchQueryEntry;
  links: RefetchQueryEntry;
  receipts: RefetchQueryEntry;
  allTags: RefetchQueryEntry;
  events: RefetchQueryEntry;
  mhist: RefetchQueryEntry;
  search: RefetchQueryEntry;
  counterpartyLinks: RefetchQueryEntry;
  canHistory: boolean;
  showTags: boolean;
  linking: boolean;
  linkQuery: string;
  linkTarget: unknown;
}): RefetchQueryEntry[];

export function buildSplitEditorAuxiliaryRefetchQueries(ctx: {
  categories: RefetchQueryEntry;
}): RefetchQueryEntry[];

export function buildAccountDetailRefetchQueries(ctx: {
  accounts: RefetchQueryEntry;
  txns: RefetchQueryEntry;
}): RefetchQueryEntry[];

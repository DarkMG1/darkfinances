/**
 * Visible auxiliary read queries for transaction/split editors.
 * Primary detail query keeps its own refetch banner to avoid duplicate messaging.
 */

/**
 * @param {{
 *   categories: { isError?: boolean; data?: unknown; refetch?: () => unknown };
 *   recurring: { isError?: boolean; data?: unknown; refetch?: () => unknown };
 *   links: { isError?: boolean; data?: unknown; refetch?: () => unknown };
 *   receipts: { isError?: boolean; data?: unknown; refetch?: () => unknown };
 *   allTags: { isError?: boolean; data?: unknown; refetch?: () => unknown };
 *   events: { isError?: boolean; data?: unknown; refetch?: () => unknown };
 *   mhist: { isError?: boolean; data?: unknown; refetch?: () => unknown };
 *   search: { isError?: boolean; data?: unknown; refetch?: () => unknown };
 *   counterpartyLinks: { isError?: boolean; data?: unknown; refetch?: () => unknown };
 *   canHistory: boolean;
 *   showTags: boolean;
 *   linking: boolean;
 *   linkQuery: string;
 *   linkTarget: unknown;
 * }} ctx
 */
function buildTransactionEditorAuxiliaryRefetchQueries(ctx) {
  const trimmedSearch = String(ctx.linkQuery ?? '').trim();
  return [
    ctx.categories,
    ctx.recurring,
    ctx.links,
    ctx.receipts,
    { query: ctx.allTags, enabled: !!ctx.showTags },
    { query: ctx.events, enabled: !!ctx.showTags },
    { query: ctx.mhist, enabled: !!ctx.canHistory },
    { query: ctx.search, enabled: !!ctx.linking && trimmedSearch.length >= 2 },
    { query: ctx.counterpartyLinks, enabled: !!ctx.linking && ctx.linkTarget != null },
  ];
}

/**
 * @param {{
 *   categories: { isError?: boolean; data?: unknown; refetch?: () => unknown };
 * }} ctx
 */
function buildSplitEditorAuxiliaryRefetchQueries(ctx) {
  return [ctx.categories];
}

/**
 * @param {{
 *   accounts: { isError?: boolean; data?: unknown; refetch?: () => unknown };
 *   txns: { isError?: boolean; data?: unknown; refetch?: () => unknown };
 * }} ctx
 */
function buildAccountDetailRefetchQueries(ctx) {
  return [ctx.accounts, ctx.txns];
}

module.exports = {
  buildTransactionEditorAuxiliaryRefetchQueries,
  buildSplitEditorAuxiliaryRefetchQueries,
  buildAccountDetailRefetchQueries,
};

'use strict';

const FINANCE_QUERY_SCOPE_META_KEY = 'financeServerScope';
const FOREGROUND_COMPLETION_REFRESH_ERROR_CODE = 'FOREGROUND_COMPLETION_REFRESH_FAILED';

function isFinanceQueryForScope(query, scope) {
  return (
    typeof scope === 'string'
    && scope.length > 0
    && query?.meta?.[FINANCE_QUERY_SCOPE_META_KEY] === scope
  );
}

async function refreshActiveFinanceQueriesForScope(queryClient, scope) {
  const predicate = (query) => isFinanceQueryForScope(query, scope);
  await queryClient.invalidateQueries({
    type: 'active',
    predicate,
    refetchType: 'none',
  });
  await queryClient.refetchQueries(
    { type: 'active', predicate },
    { throwOnError: true },
  );
}

function numericHttpStatus(error) {
  const candidate = Number(error?.status);
  return Number.isInteger(candidate) && candidate >= 100 && candidate <= 599
    ? candidate
    : 0;
}

async function reconcileFinanceOperationsOnForeground({
  reconcile,
  refreshCompletedQueries,
  clearDiagnostic,
  recordDiagnostic,
}) {
  let summary;
  try {
    summary = await reconcile();
  } catch (error) {
    recordDiagnostic(error);
    return null;
  }

  if (summary.completed > 0) {
    try {
      await refreshCompletedQueries();
    } catch (error) {
      recordDiagnostic({
        code: FOREGROUND_COMPLETION_REFRESH_ERROR_CODE,
        status: numericHttpStatus(error),
      });
      return summary;
    }
  }

  clearDiagnostic();
  return summary;
}

module.exports = {
  FINANCE_QUERY_SCOPE_META_KEY,
  FOREGROUND_COMPLETION_REFRESH_ERROR_CODE,
  isFinanceQueryForScope,
  reconcileFinanceOperationsOnForeground,
  refreshActiveFinanceQueriesForScope,
};

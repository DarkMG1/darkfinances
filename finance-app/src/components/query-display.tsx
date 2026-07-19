import React from 'react';
import { ErrorState } from '@/components/ui';
import { QueryRefetchBanner } from '@/components/query-refetch-banner';
import {
  collectRefetchErrorQueries,
  queryErrorMessage,
  shouldShowFatalError,
  shouldShowInitialLoad,
  shouldShowRefetchError,
} from '@/lib/query-display-state.js';

export type QueryLike = {
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  data?: unknown;
  refetch?: () => unknown;
};

export type RefetchQueryEntry = QueryLike | { query: QueryLike; enabled?: boolean };

export function resolveQueryDisplay(query: QueryLike) {
  const data = query.data;
  return {
    data,
    initialLoad: shouldShowInitialLoad(!!query.isLoading, data),
    fatalError: shouldShowFatalError(!!query.isError, data),
    refetchError: shouldShowRefetchError(!!query.isError, data),
    errorMessage: queryErrorMessage(query.error),
  };
}

export function refetchQueries(queries: QueryLike[]) {
  return Promise.all(
    queries
      .map((query) => query.refetch?.())
      .filter((refetch) => refetch != null),
  );
}

export function QueryRefetchBanners({
  queries,
  testID = 'query-refetch-banner',
  message,
}: {
  queries: RefetchQueryEntry[];
  testID?: string;
  message?: string;
}) {
  const failed = collectRefetchErrorQueries(
    queries as (QueryLike | { query: QueryLike; enabled?: boolean })[],
  );
  if (!failed.length) return null;

  const onRetry = () => refetchQueries(failed);
  const bannerMessage = message ?? (
    failed.length === 1
      ? 'Could not refresh · showing cached data · tap to retry'
      : `Could not refresh ${failed.length} sections · showing cached data · tap to retry`
  );

  return (
    <QueryRefetchBanner
      message={bannerMessage}
      onRetry={onRetry}
      testID={testID}
    />
  );
}

export function QueryFatalGate({
  query,
  onRetry,
  loading = null,
  children,
  retryLabel,
}: {
  query: QueryLike;
  onRetry?: () => void;
  loading?: React.ReactNode;
  children: React.ReactNode;
  retryLabel?: string;
}) {
  const display = resolveQueryDisplay(query);
  if (display.initialLoad) return <>{loading}</>;
  if (display.fatalError) {
    return (
      <ErrorState
        error={display.errorMessage}
        onRetry={onRetry ?? (() => query.refetch?.())}
        retryLabel={retryLabel}
      />
    );
  }
  return <>{children}</>;
}

export function QueryScreenBody({
  query,
  onRetry,
  loading = null,
  empty = null,
  hasContent,
  children,
  retryLabel,
  refetchBannerTestID,
}: {
  query: QueryLike;
  onRetry?: () => void;
  loading?: React.ReactNode;
  empty?: React.ReactNode;
  hasContent: boolean;
  children: React.ReactNode;
  retryLabel?: string;
  refetchBannerTestID?: string;
}) {
  const display = resolveQueryDisplay(query);
  const retry = onRetry ?? (() => query.refetch?.());

  if (display.initialLoad) return <>{loading}</>;
  if (display.fatalError) {
    return (
      <ErrorState
        error={display.errorMessage}
        onRetry={retry}
        retryLabel={retryLabel}
      />
    );
  }

  return (
    <>
      {display.refetchError ? (
        <QueryRefetchBanner onRetry={retry} testID={refetchBannerTestID} />
      ) : null}
      {!hasContent ? empty : children}
    </>
  );
}

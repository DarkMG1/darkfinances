import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshControl, RefreshControlProps } from 'react-native';
import { haptics } from '@/lib/haptics';
import { colors } from '@/theme/colors';

export type RefreshAction = () => unknown | Promise<unknown>;

const REFRESH_TIMEOUT_MS = 30_000;

export function GestureRefreshControl({
  onRefresh,
  ...props
}: Omit<RefreshControlProps, 'refreshing' | 'onRefresh'> & { onRefresh: RefreshAction }) {
  const [refreshing, setRefreshing] = useState(false);
  const active = useRef(false);
  const generation = useRef(0);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const finish = useCallback((currentGeneration: number) => {
    if (generation.current !== currentGeneration) return;
    active.current = false;
    setRefreshing(false);
    if (timeout.current) {
      clearTimeout(timeout.current);
      timeout.current = null;
    }
  }, []);

  const handleRefresh = useCallback(() => {
    if (active.current) return;
    active.current = true;
    const currentGeneration = ++generation.current;
    setRefreshing(true);
    haptics.light();

    timeout.current = setTimeout(() => finish(currentGeneration), REFRESH_TIMEOUT_MS);
    try {
      Promise.resolve(onRefresh())
        .catch(() => undefined)
        .finally(() => finish(currentGeneration));
    } catch {
      finish(currentGeneration);
    }
  }, [finish, onRefresh]);

  useEffect(() => () => {
    generation.current += 1;
    if (timeout.current) clearTimeout(timeout.current);
  }, []);

  return (
    <RefreshControl
      {...props}
      tintColor={props.tintColor ?? colors.accent}
      refreshing={refreshing}
      onRefresh={handleRefresh}
    />
  );
}

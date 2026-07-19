import React from 'react';
import { View } from 'react-native';
import { useSegments } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FinanceStatusBanner } from '@/components/finance-status-banner';
import { ReconnectStaleBanner } from '@/components/reconnect-stale-banner';
import {
  GLOBAL_FINANCE_BANNER_Z_INDEX,
  resolveGlobalFinanceBannerLayout,
  resolveGlobalFinanceBannerOffsets,
  shouldMountGlobalFinanceBanners,
} from '@/lib/global-finance-banner-layer.js';

export function GlobalFinanceBanners({ privacyGateActive }: { privacyGateActive: boolean }) {
  const insets = useSafeAreaInsets();
  const segments = useSegments();
  if (!shouldMountGlobalFinanceBanners(true, privacyGateActive)) return null;

  const layout = resolveGlobalFinanceBannerLayout(segments as string[]);
  const offsets = resolveGlobalFinanceBannerOffsets(insets.top, layout);

  return (
    <View
      pointerEvents="box-none"
      testID="global-finance-banners"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        zIndex: GLOBAL_FINANCE_BANNER_Z_INDEX,
      }}
    >
      <FinanceStatusBanner top={offsets.statusTop} />
      <ReconnectStaleBanner top={offsets.staleTop} />
    </View>
  );
}

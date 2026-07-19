import React from 'react';
import { View } from 'react-native';
import { FinanceStatusBanner } from '@/components/finance-status-banner';
import { ReconnectStaleBanner } from '@/components/reconnect-stale-banner';

export function GlobalFinanceBanners() {
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 10_000 }}>
      <FinanceStatusBanner />
      <ReconnectStaleBanner />
    </View>
  );
}

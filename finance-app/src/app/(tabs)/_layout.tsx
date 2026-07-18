import React from 'react';
import { ColorValue, StyleSheet, View } from 'react-native';
import { Tabs } from 'expo-router';
import { SymbolView, SymbolViewProps } from 'expo-symbols';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { WidgetSync } from '@/components/widget-sync';
import { FinanceStatusBanner } from '@/components/finance-status-banner';
import { ReconnectStaleBanner } from '@/components/reconnect-stale-banner';
import { haptics } from '@/lib/haptics';
import { colors } from '@/theme/colors';

function TabIcon({ name, color }: { name: SymbolViewProps['name']; color: ColorValue }) {
  return <SymbolView name={name} tintColor={color} size={26} resizeMode="scaleAspectFit" />;
}

export default function TabsLayout() {
  // Frosted bar on devices that support Liquid Glass; clean solid bar otherwise.
  // Kept in normal flow (not absolute) so no screen padding changes are needed.
  const glass = isLiquidGlassAvailable();
  return (
    <View style={{ flex: 1 }}>
    <WidgetSync />
    <Tabs
      screenListeners={{ tabPress: () => haptics.tap() }}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accentLight,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: glass ? 'transparent' : colors.surface, borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth },
        tabBarBackground: glass ? () => <GlassView style={StyleSheet.absoluteFill} glassEffectStyle="regular" colorScheme="dark" /> : undefined,
        tabBarLabelStyle: { fontSize: 10, fontWeight: '600' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarButtonTestID: 'home-tab', tabBarIcon: ({ color }) => <TabIcon name="house.fill" color={color} /> }} />
      <Tabs.Screen name="spending" options={{ title: 'Spending', tabBarButtonTestID: 'spending-tab', tabBarIcon: ({ color }) => <TabIcon name="creditcard.fill" color={color} /> }} />
      <Tabs.Screen name="transactions" options={{ title: 'Activity', tabBarButtonTestID: 'activity-tab', tabBarIcon: ({ color }) => <TabIcon name="list.bullet" color={color} /> }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarButtonTestID: 'settings-tab', tabBarIcon: ({ color }) => <TabIcon name="gearshape.fill" color={color} /> }} />
    </Tabs>
    <FinanceStatusBanner />
    <ReconnectStaleBanner />
    </View>
  );
}

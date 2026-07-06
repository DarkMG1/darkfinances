import React, { useEffect } from 'react';
import { StyleSheet, View, ViewStyle, DimensionValue } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { colors } from '@/theme/colors';

// A single shimmering placeholder block. Pulses opacity (cheap + reliable) so
// loading states feel alive instead of a blank spinner.
export function Skeleton({ width, height = 14, radius = 7, style }: {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  style?: ViewStyle;
}) {
  const o = useSharedValue(0.35);
  useEffect(() => {
    o.value = withRepeat(withTiming(0.85, { duration: 850 }), -1, true);
  }, [o]);
  const anim = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={[{ width: width ?? '100%', height, borderRadius: radius, backgroundColor: colors.surface2 }, anim, style]} />;
}

// A row that mirrors the avatar + two-line layout used across the app's lists.
export function SkeletonRow() {
  return (
    <View style={styles.row}>
      <Skeleton width={38} height={38} radius={19} />
      <View style={{ flex: 1, gap: 7 }}>
        <Skeleton width="55%" height={13} />
        <Skeleton width="35%" height={10} />
      </View>
      <Skeleton width={56} height={13} />
    </View>
  );
}

// A card full of skeleton rows — drop-in replacement for <Loading/> on list screens.
export function SkeletonList({ rows = 6, hero = false }: { rows?: number; hero?: boolean }) {
  return (
    <View>
      {hero ? (
        <View style={{ marginTop: 8, marginBottom: 20, gap: 10 }}>
          <Skeleton width={110} height={11} />
          <Skeleton width={200} height={38} radius={10} />
          <Skeleton width={150} height={12} />
        </View>
      ) : null}
      <View style={styles.card}>
        {Array.from({ length: rows }).map((_, i) => (
          <SkeletonRow key={i} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 },
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 4 },
});

import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextStyle, View, ViewStyle } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { SymbolView, SymbolViewProps } from 'expo-symbols';
import {
  AccessibilityAnnouncementEffect,
  visibleStatusLiveRegionProps,
} from '@/components/accessibility-live-region';
import { colors } from '@/theme/colors';
import { categoryIcon, monogramColor } from '@/theme/categoryIcons';

export function Card({ children, style, testID, ...a11y }: {
  children: React.ReactNode;
  style?: ViewStyle;
  testID?: string;
  accessible?: boolean;
  accessibilityLabel?: string;
}) {
  return <View testID={testID} style={[styles.card, style]} {...a11y}>{children}</View>;
}

export function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionLabel}>{children}</Text>
      {right}
    </View>
  );
}

export function CardTitle({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  return <Text style={[styles.cardTitle, style]}>{children}</Text>;
}

export function StatCard({ label, value, valueColor, sub, subColor, onPress, testID, accessibilityLabel }: {
  label: string; value: string; valueColor?: string; sub?: string; subColor?: string; onPress?: () => void; testID?: string; accessibilityLabel?: string;
}) {
  const a11yLabel = accessibilityLabel ?? (sub ? `${label}, ${value}, ${sub}` : `${label}, ${value}`);
  const body = (
    <>
      <Text style={styles.statLabel} accessibilityElementsHidden importantForAccessibility="no">{label}</Text>
      <Text
        style={[styles.statValue, valueColor ? { color: valueColor } : null]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.6}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        {value}
      </Text>
      {sub ? <Text style={[styles.statSub, subColor ? { color: subColor } : null]} accessibilityElementsHidden importantForAccessibility="no">{sub}</Text> : null}
    </>
  );
  if (onPress) {
    return (
      <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={a11yLabel} style={({ pressed }) => [styles.card, styles.statCard, pressed && { opacity: 0.6 }]} onPress={onPress}>
        {body}
      </Pressable>
    );
  }
  return <View testID={testID} accessible accessibilityLabel={a11yLabel} style={[styles.card, styles.statCard]}>{body}</View>;
}

// Offline merchant/category avatar. Pass `label` (payee) for a colored monogram,
// or `category` for an SF-Symbol glyph. If both are given, the monogram is tinted
// with the category color so colors stay meaningful.
export function Avatar({ label, category, size = 38, style }: {
  label?: string;
  category?: string;
  size?: number;
  style?: ViewStyle;
}) {
  const cat = category ? categoryIcon(category) : null;
  const dim = { width: size, height: size, borderRadius: size / 2 };
  if (label && label.trim()) {
    const color = cat ? cat.color : monogramColor(label);
    return (
      <View style={[dim, styles.avatar, { backgroundColor: color + '22' }, style]}>
        <Text style={{ color, fontSize: Math.round(size * 0.42), fontWeight: '700' }}>{label.trim().charAt(0).toUpperCase()}</Text>
      </View>
    );
  }
  const icon = cat ?? { symbol: 'creditcard.fill' as SymbolViewProps['name'], color: colors.muted };
  return (
    <View style={[dim, styles.avatar, { backgroundColor: icon.color + '22' }, style]}>
      <SymbolView name={icon.symbol} tintColor={icon.color} size={Math.round(size * 0.5)} resizeMode="scaleAspectFit" />
    </View>
  );
}

// Canonical list row: avatar + title/subtitle + right value (+ optional chevron).
// Replaces the bespoke per-screen row styles so every list looks the same.
export function ListRow({ avatar, title, subtitle, value, valueColor, valueSub, onPress, chevron = true, dim, right, testID, accessibilityLabel }: {
  avatar?: React.ReactNode;
  title: string;
  subtitle?: string;
  value?: string;
  valueColor?: string;
  valueSub?: string;
  onPress?: () => void;
  chevron?: boolean;
  dim?: boolean;
  right?: React.ReactNode;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const a11yLabel = accessibilityLabel ?? [title, subtitle, value, valueSub].filter(Boolean).join(', ');
  const inner = (
    <>
      {avatar}
      <View style={styles.rowMid}>
        <Text style={[styles.rowTitle, dim && { color: colors.muted }]} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={styles.rowSub} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {right ? right : value != null ? (
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[styles.rowValue, valueColor ? { color: valueColor } : null, dim && { color: colors.muted }]} numberOfLines={1}>{value}</Text>
          {valueSub ? <Text style={styles.rowValueSub} numberOfLines={1}>{valueSub}</Text> : null}
        </View>
      ) : null}
      {onPress && chevron ? <SymbolView name="chevron.right" tintColor={colors.muted} size={12} resizeMode="scaleAspectFit" style={styles.rowChevron} /> : null}
    </>
  );
  if (onPress) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={a11yLabel} testID={testID} onPress={onPress} style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}>
        {inner}
      </Pressable>
    );
  }
  return <View testID={testID} style={styles.row}>{inner}</View>;
}

// Pressable with a subtle scale+fade for a tactile, premium press feel.
export function PressableScale({ onPress, children, style, scale = 0.97, disabled }: {
  onPress?: () => void;
  children: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
  scale?: number;
  disabled?: boolean;
}) {
  return (
    <Pressable accessibilityRole={onPress ? 'button' : undefined} onPress={onPress} disabled={disabled} style={({ pressed }) => [style as ViewStyle, pressed && { opacity: 0.88, transform: [{ scale }] }]}>
      {children}
    </Pressable>
  );
}

export function Pill({ text, kind = 'open' }: { text: string; kind?: 'open' | 'paid' | 'partial' }) {
  const bg = kind === 'open' ? 'rgba(234,179,8,0.14)' : kind === 'paid' ? 'rgba(34,197,94,0.14)' : 'rgba(124,110,247,0.14)';
  const fg = kind === 'open' ? colors.yellow : kind === 'paid' ? colors.green : colors.accentLight;
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={[styles.pillText, { color: fg }]}>{text.toUpperCase()}</Text>
    </View>
  );
}

// Small inline badge for transactions that haven't posted yet (cleared === false).
// Shown next to the payee in every transaction list so balances make sense.
export function PendingPill() {
  return (
    <View style={styles.pendingPill}>
      <Text style={styles.pendingPillText}>PENDING</Text>
    </View>
  );
}

// Glyph for a collapsed split row (one line standing in for N legs). The branch
// symbol mirrors Rocket Money's split marker; falls back to a count pill.
export function SplitPill({ count }: { count?: number }) {
  return (
    <View style={styles.splitPill}>
      <SymbolView name="arrow.triangle.branch" size={11} tintColor={colors.accentLight} fallback={<Text style={styles.splitPillText}>SPLIT</Text>} />
      {count ? <Text style={styles.splitPillText}>{count}</Text> : null}
    </View>
  );
}

export function TagChips({
  tags,
  style,
  onPressTag,
  onRemoveTag,
  disabled = false,
}: {
  tags: { raw: string; label: string; kind: 'event' | 'tag' }[];
  style?: ViewStyle;
  onPressTag?: (raw: string) => void;
  onRemoveTag?: (raw: string) => void;
  disabled?: boolean;
}) {
  if (!tags?.length) return null;
  return (
    <View style={[styles.tagRow, style, disabled && { opacity: 0.45 }]}>
      {tags.map((t, i) => {
        const tint = t.kind === 'event' ? colors.accentLight : colors.green;
        return (
          <View key={t.raw + i} style={[styles.tag, t.kind === 'event' ? styles.tagEvent : styles.tagPerson]}>
            <Pressable
              onPress={onPressTag && !disabled ? () => onPressTag(t.raw) : undefined}
              disabled={!onPressTag || disabled}
              style={({ pressed }) => [styles.tagPress, pressed && onPressTag && !disabled ? { opacity: 0.6 } : null]}
            >
              <SymbolView
                name={t.kind === 'event' ? 'mappin.and.ellipse' : 'number'}
                tintColor={tint}
                size={10}
                resizeMode="scaleAspectFit"
                style={styles.tagIcon}
              />
              <Text style={[styles.tagText, { color: tint }]}>
                {t.label.charAt(0).toUpperCase() + t.label.slice(1)}
              </Text>
            </Pressable>
            {onRemoveTag ? (
              <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${t.label} tag`} accessibilityState={{ disabled }} hitSlop={16} onPress={() => { if (!disabled) onRemoveTag(t.raw); }} disabled={disabled} style={({ pressed }) => (pressed && !disabled ? { opacity: 0.5 } : null)}>
                <SymbolView name="xmark.circle.fill" tintColor={tint} size={13} resizeMode="scaleAspectFit" style={styles.tagRemove} />
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

export function Loading({ text }: { text?: string }) {
  const label = text?.trim() || 'Loading';
  return (
    <View
      style={styles.center}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityState={{ busy: true }}
      {...visibleStatusLiveRegionProps()}
    >
      <AccessibilityAnnouncementEffect message={label} />
      <ActivityIndicator color={colors.accent} accessibilityElementsHidden importantForAccessibility="no" />
      {text ? <Text style={styles.muted} accessibilityElementsHidden importantForAccessibility="no">{text}</Text> : null}
    </View>
  );
}

export function EmptyState({ children, icon }: { children: React.ReactNode; icon?: SymbolViewProps['name'] }) {
  return (
    <Animated.View entering={FadeIn.duration(260)} style={styles.empty}>
      {icon ? (
        <SymbolView name={icon} tintColor={colors.muted} size={34} resizeMode="scaleAspectFit" style={styles.emptyIcon} />
      ) : null}
      <Text style={[styles.muted, { textAlign: 'center' }]}>{children}</Text>
    </Animated.View>
  );
}

export function ErrorState({ error, onRetry, retryLabel = 'Tap to retry' }: { error?: string; onRetry?: () => void; retryLabel?: string }) {
  const message = error || 'Something went wrong';
  return (
    <Animated.View entering={FadeIn.duration(260)} style={styles.center}>
      <AccessibilityAnnouncementEffect message={message} />
      <SymbolView name="exclamationmark.triangle" tintColor={colors.red} size={32} resizeMode="scaleAspectFit" style={{ opacity: 0.85 }} accessibilityElementsHidden importantForAccessibility="no" />
      <Text
        accessibilityRole="text"
        {...visibleStatusLiveRegionProps()}
        style={[styles.muted, { color: colors.red, textAlign: 'center' }]}
      >
        {message}
      </Text>
      {onRetry ? (
        <Pressable accessibilityRole="button" accessibilityLabel={retryLabel} onPress={onRetry} style={({ pressed }) => [styles.retry, pressed && { opacity: 0.6 }]}>
          <Text style={[styles.muted, { color: colors.accentLight, marginTop: 4, fontWeight: '600' }]}>{retryLabel}</Text>
        </Pressable>
      ) : null}
    </Animated.View>
  );
}

export const text = StyleSheet.create({
  h1: { color: colors.text, fontSize: 30, fontWeight: '700', letterSpacing: -1 },
  hero: { color: colors.text, fontSize: 42, fontWeight: '800', letterSpacing: -1.5 },
  body: { color: colors.text, fontSize: 14 },
  muted: { color: colors.muted, fontSize: 13 },
}) as { h1: TextStyle; hero: TextStyle; body: TextStyle; muted: TextStyle };

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 14, padding: 16 },
  sectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, marginTop: 8 },
  sectionLabel: { color: colors.muted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  cardTitle: { color: colors.muted, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 },
  statCard: { flex: 1 },
  statLabel: { color: colors.muted, fontSize: 12, marginBottom: 4 },
  statValue: { color: colors.text, fontSize: 22, fontWeight: '700', letterSpacing: -0.5 },
  statSub: { color: colors.muted, fontSize: 11, marginTop: 4 },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, alignSelf: 'flex-start' },
  pillText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.4 },
  pendingPill: { backgroundColor: 'rgba(234,179,8,0.16)', borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1, flexShrink: 0 },
  pendingPillText: { color: colors.yellow, fontSize: 9, fontWeight: '800', letterSpacing: 0.4 },
  splitPill: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(124,110,247,0.16)', borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2, flexShrink: 0 },
  splitPillText: { color: colors.accentLight, fontSize: 9, fontWeight: '800', letterSpacing: 0.4 },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, minHeight: 44 },
  rowMid: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  rowValue: { color: colors.text, fontSize: 15, fontWeight: '700' },
  rowValueSub: { color: colors.muted, fontSize: 11, marginTop: 2 },
  rowChevron: { width: 12, height: 12, marginLeft: 2 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 11, borderWidth: 1 },
  tagEvent: { backgroundColor: 'rgba(124,110,247,0.12)', borderColor: 'rgba(124,110,247,0.4)' },
  tagPerson: { backgroundColor: 'rgba(34,197,94,0.12)', borderColor: 'rgba(34,197,94,0.4)' },
  tagIcon: { width: 10, height: 10 },
  tagPress: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  tagRemove: { width: 13, height: 13 },
  tagText: { fontSize: 12, fontWeight: '700' },
  center: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  empty: { alignItems: 'center', padding: 24 },
  emptyIcon: { width: 34, height: 34, marginBottom: 10, opacity: 0.6 },
  muted: { color: colors.muted, fontSize: 13 },
  retry: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
});

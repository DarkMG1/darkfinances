import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { haptics } from '@/lib/haptics';
import Svg, { Circle, G, Line, Polygon, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { colors, fmtK, fmtMoney, monthLabel } from '@/theme/colors';

export type ChartSeriesValue = number | null;

export function trendPeriodComplete(m: {
  complete?: boolean;
  spend?: number | null;
  income?: number | null;
  net?: number | null;
}): boolean {
  return m.complete !== false && m.spend != null && m.income != null;
}

function seriesMax(...series: ChartSeriesValue[][]): number {
  let max = 0;
  for (const values of series) {
    for (const value of values) {
      if (value != null && value > max) max = value;
    }
  }
  return Math.max(max, 1);
}

function chartAccessibilityPart(label: string, income: ChartSeriesValue, spend: ChartSeriesValue): string {
  if (income == null || spend == null) return `${label} unavailable`;
  return `${label} income ${fmtMoney(income)} spending ${fmtMoney(spend)}`;
}

const shortMonth = (key: string): string => {
  const [y, m] = key.split('-').map(Number);
  if (!y || !m) return key;
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short' });
};

export function Donut({ size = 180, thickness = 22, data }: {
  size?: number; thickness?: number; data: { label: string; value: number; color: string }[];
}) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const r = (size - thickness) / 2;
  const circumference = 2 * Math.PI * r;
  const cx = size / 2;
  const cy = size / 2;
  const lengths = data.map((d) => (d.value / total) * circumference);
  const offsets = lengths.map((_, i) => lengths.slice(0, i).reduce((sum, len) => sum + len, 0));
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Breakdown: ${data.map((item) => `${item.label} ${fmtMoney(item.value)}`).join(', ')}`}
      style={{ width: size, height: size }}
    >
    <Svg width={size} height={size}>
      <G rotation={-90} origin={`${cx}, ${cy}`}>
        <Circle cx={cx} cy={cy} r={r} stroke={colors.surface2} strokeWidth={thickness} fill="none" />
        {data.map((d, i) => {
          const len = lengths[i];
          return (
            <Circle
              key={i}
              cx={cx}
              cy={cy}
              r={r}
              stroke={d.color}
              strokeWidth={thickness}
              fill="none"
              strokeDasharray={`${len} ${circumference - len}`}
              strokeDashoffset={-offsets[i]}
              strokeLinecap="butt"
            />
          );
        })}
      </G>
    </Svg>
    </View>
  );
}

export function LineChart({ width, height = 160, values, color = colors.accent }: {
  width: number; height?: number; values: number[]; color?: string;
}) {
  if (!values || values.length < 2 || width <= 0) return <View style={{ height }} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 10;
  const stepX = (width - pad * 2) / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (1 - (v - min) / range) * (height - pad * 2);
    return [x, y] as const;
  });
  const poly = pts.map((p) => p.join(',')).join(' ');
  const area = `${poly} ${pad + (values.length - 1) * stepX},${height - pad} ${pad},${height - pad}`;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={`Trend from ${fmtMoney(values[0])} to ${fmtMoney(values[values.length - 1])}`} style={{ width, height }}>
    <Svg width={width} height={height}>
      <Polygon points={area} fill={color + '22'} />
      <Polyline points={poly} fill="none" stroke={color} strokeWidth={2} />
      {pts.map((p, i) => (
        <Circle key={i} cx={p[0]} cy={p[1]} r={2} fill={color} />
      ))}
    </Svg>
    </View>
  );
}

// Interactive area chart with value axes, gridlines, month labels, and a
// touch-and-drag scrubber that surfaces each point's exact value + date.
export function AreaChart({
  width,
  height = 210,
  points,
  color = colors.accent,
  formatValue = fmtMoney,
}: {
  width: number;
  height?: number;
  points: { value: number; label: string }[];
  color?: string;
  formatValue?: (n: number) => string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const n = points?.length ?? 0;
  if (!points || n < 2 || width <= 0) return <View style={{ height }} />;

  const values = points.map((p) => p.value);
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const span = dataMax - dataMin || Math.abs(dataMax) || 1;
  const domMin = dataMin - span * 0.08;
  const domMax = dataMax + span * 0.08;
  const domRange = domMax - domMin || 1;

  const leftGutter = 48;
  const rightPad = 12;
  const topPad = 14;
  const bottomGutter = 22;
  const plotW = width - leftGutter - rightPad;
  const plotH = height - topPad - bottomGutter;

  const xAt = (i: number) => leftGutter + (i / (n - 1)) * plotW;
  const yAt = (v: number) => topPad + (1 - (v - domMin) / domRange) * plotH;

  const pts = values.map((v, i) => [xAt(i), yAt(v)] as const);
  const line = pts.map((p) => p.join(',')).join(' ');
  const areaPoly = `${line} ${xAt(n - 1)},${topPad + plotH} ${xAt(0)},${topPad + plotH}`;

  const TICKS = 4;
  const yTicks = Array.from({ length: TICKS }, (_, i) => dataMin + (i / (TICKS - 1)) * (dataMax - dataMin));
  const xCount = Math.min(5, n);
  const xIdx = Array.from({ length: xCount }, (_, i) => Math.round((i / (xCount - 1)) * (n - 1)));

  const updateActive = (locationX: number) => {
    const rel = (locationX - leftGutter) / plotW;
    setActive(Math.max(0, Math.min(n - 1, Math.round(rel * (n - 1)))));
  };

  const tipW = 108;
  const tipLeft = active != null ? Math.max(2, Math.min(width - tipW - 2, xAt(active) - tipW / 2)) : 0;
  const tipTop = active != null ? Math.max(0, Math.min(height - 46, yAt(values[active]) - 50)) : 0;

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Trend from ${points[0].label} ${formatValue(values[0])} to ${points[n - 1].label} ${formatValue(values[n - 1])}`}
      style={{ width, height }}
    >
      <Svg width={width} height={height}>
        {yTicks.map((tv, i) => {
          const y = yAt(tv);
          return (
            <G key={`y${i}`}>
              <Line x1={leftGutter} y1={y} x2={leftGutter + plotW} y2={y} stroke={colors.border} strokeWidth={1} />
              <SvgText x={leftGutter - 6} y={y + 3} fill={colors.muted} fontSize={9} textAnchor="end">{fmtK(tv)}</SvgText>
            </G>
          );
        })}
        {xIdx.map((i) => (
          <SvgText key={`x${i}`} x={xAt(i)} y={height - 6} fill={colors.muted} fontSize={9} textAnchor="middle">{shortMonth(points[i].label)}</SvgText>
        ))}
        <Polygon points={areaPoly} fill={color + '22'} />
        <Polyline points={line} fill="none" stroke={color} strokeWidth={2} />
        <Circle cx={xAt(n - 1)} cy={yAt(values[n - 1])} r={3} fill={color} />
        {active != null ? (
          <G>
            <Line x1={xAt(active)} y1={topPad} x2={xAt(active)} y2={topPad + plotH} stroke={colors.muted} strokeWidth={1} strokeDasharray="3 3" />
            <Circle cx={xAt(active)} cy={yAt(values[active])} r={5} fill={color} stroke={colors.bg} strokeWidth={2} />
          </G>
        ) : null}
      </Svg>
      {active != null ? (
        <View style={[styles.tooltip, { left: tipLeft, top: tipTop, width: tipW }]} pointerEvents="none">
          <Text style={styles.tipValue}>{formatValue(values[active])}</Text>
          <Text style={styles.tipLabel}>{monthLabel(points[active].label)}</Text>
        </View>
      ) : null}
      <View
        style={StyleSheet.absoluteFill}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(e) => updateActive(e.nativeEvent.locationX)}
        onResponderMove={(e) => updateActive(e.nativeEvent.locationX)}
        onResponderRelease={() => setActive(null)}
        onResponderTerminate={() => setActive(null)}
      />
    </View>
  );
}

export function GroupedBars({ width, height = 180, labels, seriesA, seriesB, colorA = colors.green, colorB = colors.red }: {
  width: number; height?: number; labels: string[]; seriesA: ChartSeriesValue[]; seriesB: ChartSeriesValue[]; colorA?: string; colorB?: string;
}) {
  if (width <= 0 || !labels.length) return <View style={{ height }} />;
  const max = seriesMax(seriesA, seriesB);
  const pad = 8;
  const baseY = height - 18;
  const groupW = (width - pad * 2) / labels.length;
  const barW = Math.max(3, Math.min(11, groupW / 3));
  const accessibilityLabel = `Grouped comparison: ${labels.map((lab, i) => chartAccessibilityPart(lab, seriesA[i], seriesB[i])).join('; ')}`;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel} style={{ width, height }}>
    <Svg width={width} height={height}>
      {labels.map((lab, i) => {
        const gx = pad + i * groupW + groupW / 2;
        const income = seriesA[i];
        const spend = seriesB[i];
        const unavailable = income == null || spend == null;
        if (unavailable) {
          return (
            <G key={i}>
              <Rect x={gx - barW - 2} y={baseY - 10} width={barW * 2 + 4} height={10} rx={2} fill={colors.surface2} stroke={colors.muted} strokeWidth={1} strokeDasharray="2 2" />
              <SvgText x={gx} y={baseY - 2} fill={colors.muted} fontSize={7} textAnchor="middle">—</SvgText>
              <SvgText x={gx} y={height - 4} fill={colors.muted} fontSize={8} textAnchor="middle">{lab}</SvgText>
            </G>
          );
        }
        const aH = (income / max) * (baseY - 8);
        const bH = (spend / max) * (baseY - 8);
        return (
          <G key={i}>
            <Rect x={gx - barW - 1} y={baseY - aH} width={barW} height={aH || (income === 0 ? 0 : 2)} rx={2} fill={colorA} />
            <Rect x={gx + 1} y={baseY - bH} width={barW} height={bH || (spend === 0 ? 0 : 2)} rx={2} fill={colorB} />
            <SvgText x={gx} y={height - 4} fill={colors.muted} fontSize={8} textAnchor="middle">{lab}</SvgText>
          </G>
        );
      })}
    </Svg>
    </View>
  );
}

// Tappable, horizontally-scrollable monthly-spend bars. Each column jumps the
// Spending tab to that month; the selected column is highlighted and shows its
// total. Auto-centers on the selected month (i.e. the most recent) on mount.
export function MonthBars({ data, selected, onSelect, height = 120 }: {
  data: { month: string; spend: number | null }[];
  selected: string;
  onSelect: (m: string) => void;
  height?: number;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const [viewW, setViewW] = useState(0);
  const didInit = useRef(false);

  const PAD = 8;
  const COL_W = 30;
  const BAR_W = 18;
  const LABEL_H = 16;
  const VALUE_H = 14;
  const barMax = Math.max(20, height - LABEL_H - VALUE_H);
  const knownSpends = data.map((d) => d.spend).filter((v): v is number => v != null);
  const max = knownSpends.length ? Math.max(1, ...knownSpends) : 1;
  const selIdx = data.findIndex((d) => d.month === selected);

  useEffect(() => {
    if (!scrollRef.current || viewW <= 0 || selIdx < 0) return;
    const x = Math.max(0, PAD + selIdx * COL_W + COL_W / 2 - viewW / 2);
    scrollRef.current.scrollTo({ x, animated: didInit.current });
    didInit.current = true;
  }, [selIdx, viewW]);

  if (!data.length) return <View style={{ height }} />;

  return (
    <View style={{ height }} onLayout={(e) => setViewW(e.nativeEvent.layout.width)}>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.barsRow}
      >
        {data.map((d) => {
          const on = d.month === selected;
          const unavailable = d.spend == null;
          const spend = d.spend ?? 0;
          const h = unavailable ? 10 : spend > 0 ? Math.max(3, (spend / max) * barMax) : 2;
          const valueLabel = unavailable ? 'Unavailable' : fmtMoney(spend);
          return (
            <Pressable
              key={d.month}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${monthLabel(d.month)}, ${valueLabel} spent`}
              onPress={() => { haptics.tap(); onSelect(d.month); }}
              style={[styles.barCol, { width: COL_W, height }]}
              hitSlop={4}
            >
              <View style={styles.barPlot}>
                {on && !unavailable ? <Text style={styles.barValue} numberOfLines={1}>{fmtK(spend)}</Text> : null}
                {on && unavailable ? <Text style={styles.barValueUnavailable} numberOfLines={1}>—</Text> : null}
                <View
                  style={unavailable ? {
                    width: BAR_W,
                    height: h,
                    borderRadius: 4,
                    borderWidth: 1,
                    borderColor: colors.muted,
                    borderStyle: 'dashed',
                    backgroundColor: colors.surface2,
                  } : {
                    width: BAR_W,
                    height: h,
                    borderRadius: 4,
                    backgroundColor: on ? colors.accent : 'rgba(124,110,247,0.28)',
                  }}
                />
              </View>
              <Text style={[styles.barLabel, on && styles.barLabelOn]} numberOfLines={1}>
                {shortMonth(d.month)}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

// Centered `‹ June 2026 ›` arrow header sitting atop the MonthBars. `‹`/`›` step
// through `months` (disabled at the earliest data month / at the current month);
// tapping the title jumps back to the current month.
export function MonthNavigator({ months, selected, onSelect, currentKey }: {
  months: { month: string; spend: number | null }[];
  selected: string;
  onSelect: (m: string) => void;
  currentKey: string;
}) {
  const idx = months.findIndex((m) => m.month === selected);
  const canPrev = idx > 0;
  const canNext = idx >= 0 && idx < months.length - 1;
  const step = (delta: number) => {
    const t = months[idx + delta];
    if (!t) return;
    haptics.tap();
    onSelect(t.month);
  };
  return (
    <View style={styles.navWrap}>
      <View style={styles.navHeader}>
        <Pressable
          disabled={!canPrev}
          onPress={() => step(-1)}
          hitSlop={12}
          style={({ pressed }) => [styles.navBtn, pressed && canPrev && { opacity: 0.5 }]}
        >
          <Text style={[styles.navArrow, !canPrev && styles.navArrowOff]}>‹</Text>
        </Pressable>
        <Pressable
          onPress={() => { if (selected !== currentKey) { haptics.tap(); onSelect(currentKey); } }}
          style={({ pressed }) => [pressed && selected !== currentKey && { opacity: 0.5 }]}
        >
          <Text style={styles.navTitle}>{selected === currentKey ? 'This month' : monthLabel(selected)}</Text>
        </Pressable>
        <Pressable
          disabled={!canNext}
          onPress={() => step(1)}
          hitSlop={12}
          style={({ pressed }) => [styles.navBtn, pressed && canNext && { opacity: 0.5 }]}
        >
          <Text style={[styles.navArrow, !canNext && styles.navArrowOff]}>›</Text>
        </Pressable>
      </View>
      <MonthBars data={months} selected={selected} onSelect={onSelect} />
    </View>
  );
}

export function ProgressBar({ pct, over }: { pct: number; over?: boolean }) {
  const color = over ? colors.red : pct > 85 ? colors.yellow : colors.accent;
  return (
    <View style={styles.track}>
      <View style={[styles.fill, { width: `${Math.min(100, Math.max(0, pct))}%`, backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: 6, backgroundColor: colors.surface2, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  barsRow: { paddingHorizontal: 8, alignItems: 'flex-end' },
  barCol: { alignItems: 'center', justifyContent: 'flex-end' },
  barPlot: { flex: 1, width: '100%', alignItems: 'center', justifyContent: 'flex-end' },
  barValue: { color: colors.text, fontSize: 10, fontWeight: '700', marginBottom: 3 },
  barValueUnavailable: { color: colors.muted, fontSize: 10, fontWeight: '700', marginBottom: 3 },
  barLabel: { color: colors.muted, fontSize: 10, marginTop: 5 },
  barLabelOn: { color: colors.text, fontWeight: '700' },
  navWrap: { marginBottom: 20 },
  navHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, paddingHorizontal: 4 },
  navBtn: { width: 44, height: 32, alignItems: 'center', justifyContent: 'center' },
  navArrow: { color: colors.accent, fontSize: 26, fontWeight: '700', lineHeight: 28 },
  navArrowOff: { color: '#3a3a44' },
  navTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  tooltip: {
    position: 'absolute',
    backgroundColor: colors.surface2,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    alignItems: 'center',
  },
  tipValue: { color: colors.text, fontSize: 14, fontWeight: '700' },
  tipLabel: { color: colors.muted, fontSize: 10, marginTop: 1 },
});

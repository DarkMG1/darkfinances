import React, { useMemo, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, ScrollView, SectionList, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import * as FileSystem from 'expo-file-system/legacy';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAccounts, useCategories, useEvents, useSearch, useSetCategory, useTransactions } from '@/api/hooks/finance.hooks';
import { buildQuery } from '@/api/client/requests';
import { useServerConfig } from '@/state/server';
import { Transaction } from '@/api/generated/types';
import { Avatar, ErrorState, PendingPill, SplitPill } from '@/components/ui';
import { MutationFormBanner, MutationLiveRegion } from '@/components/mutation-form';
import { useMutationAction } from '@/hooks/useMutationAction';
import { GestureRefreshControl } from '@/components/gesture-refresh-control';
import { SkeletonList } from '@/components/skeleton';
import { QueryRefetchBanners } from '@/components/query-display';
import { haptics } from '@/lib/haptics';
import { startMonthsAgo, useFinanceToday } from '@/lib/date-only';
import {
  isSearchQuerySettled,
  queryErrorMessage,
  shouldShowFatalError,
  shouldShowInitialLoad,
} from '@/lib/query-display-state.js';
import { colors, fmtMoney, fmtDay } from '@/theme/colors';

type Filter = 'all' | 'expense' | 'income';
type EventGroupRow = {
  id: string;
  isEventGroup: true;
  slug: string;
  name: string;
  count: number;
  spend: number;
  net: number;
  firstDate: string;
  lastDate: string;
};
type ActivityRow = Transaction | EventGroupRow;

const RANGES: { label: string; m: number }[] = [
  { label: '1M', m: 1 },
  { label: '3M', m: 3 },
  { label: '6M', m: 6 },
  { label: '1Y', m: 12 },
];

function startMonthsAgoLocal(months: number, anchor: string): string {
  return startMonthsAgo(months, anchor);
}

export default function Transactions() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { serverUrl, token, demo } = useServerConfig();
  const financeToday = useFinanceToday();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [rangeM, setRangeM] = useState(3);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [uncatOnly, setUncatOnly] = useState(false);
  const [groupEvents, setGroupEvents] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [categorizing, setCategorizing] = useState<Transaction | null>(null);

  const accounts = useAccounts();
  const categories = useCategories();
  const events = useEvents();
  const setCategory = useSetCategory();

  // 2+ chars switches from the recent (month-bound) list to an all-time server search.
  const trimmedSearch = search.trim();
  const searching = trimmedSearch.length >= 2;
  const txnStart = startMonthsAgoLocal(rangeM, financeToday);
  const txns = useTransactions({ start: txnStart, accountId: accountId ?? undefined, collapse: true });
  const searchRes = useSearch(search);
  const searchSettled = isSearchQuerySettled(search, searchRes.activeQuery);

  const listQuery = searching ? searchRes : txns;
  const listPayload = searching
    ? (searchSettled ? searchRes.data : undefined)
    : txns.data;
  const listPending = searching && !searchSettled;
  const loading = shouldShowInitialLoad(listQuery.isLoading || listPending, listPayload);
  const fatal = shouldShowFatalError(listQuery.isError, listPayload);
  const activityRefetchQueries = useMemo(() => [
    listQuery,
    accounts,
    categories,
    { query: events, enabled: groupEvents && !searching },
  ], [accounts, categories, events, groupEvents, listQuery, searching]);
  const onRefresh = () => searching ? searchRes.refetch() : txns.refetch();

  const base = useMemo(
    () => {
      if (searching) {
        if (!searchSettled) return [];
        return searchRes.data?.transactions ?? [];
      }
      return txns.data ?? [];
    },
    [searching, searchSettled, searchRes.data, txns.data],
  );
  const categorizeAction = useMutationAction({
    mutation: setCategory,
    mutationLabel: 'Change category',
    onRefetch: onRefresh,
  });

  const sections = useMemo(() => {
    const q = search.toLowerCase();
    const eventNames = new Map((events.data?.events ?? []).map((e) => [e.slug, e.name]));
    const filtered = base.filter((t) => {
      if (filter === 'expense' && t.amount >= 0) return false;
      if (filter === 'income' && t.amount <= 0) return false;
      if (uncatOnly && t.category && t.category.trim()) return false;
      if (accountId && t.accountId !== accountId) return false;
      // When searching, the server already matched the query; only filter locally for the recent list.
      if (!searching && q && !t.payee.toLowerCase().includes(q) && !(t.category || '').toLowerCase().includes(q) && !t.account.toLowerCase().includes(q)) return false;
      return true;
    });

    const out: { title: string; date: string; data: ActivityRow[] }[] = [];
    const byDate: Record<string, ActivityRow[]> = {};
    const grouped: Record<string, EventGroupRow> = {};
    const regular: Transaction[] = [];

    for (const t of filtered) {
      const tag = !searching && groupEvents ? (t.notes || '').match(/#ev-([a-z0-9-]+)/i)?.[1]?.toLowerCase() : null;
      if (tag) {
        const cur = grouped[tag] || {
          id: `event-group-${tag}`,
          isEventGroup: true,
          slug: tag,
          name: eventNames.get(tag) || tag.replace(/-/g, ' '),
          count: 0,
          spend: 0,
          net: 0,
          firstDate: t.date,
          lastDate: t.date,
        };
        cur.count += 1;
        cur.spend += t.amount < 0 ? Math.abs(t.amount) : 0;
        cur.net += t.amount;
        if (t.date < cur.firstDate) cur.firstDate = t.date;
        if (t.date > cur.lastDate) cur.lastDate = t.date;
        grouped[tag] = cur;
      } else {
        regular.push(t);
      }
    }

    const groupedRows = Object.values(grouped).map((g) => ({ ...g, spend: Math.round(g.spend * 100) / 100, net: Math.round(g.net * 100) / 100 }));
    if (groupedRows.length) out.push({ title: 'Trips & Events', date: 'grouped-events', data: groupedRows.sort((a, b) => b.lastDate.localeCompare(a.lastDate)) });

    for (const t of regular) {
      if (!byDate[t.date]) {
        byDate[t.date] = [];
        out.push({ title: fmtDay(t.date), date: t.date, data: byDate[t.date] });
      }
      byDate[t.date].push(t);
    }
    return out;
  }, [base, search, filter, searching, accountId, uncatOnly, groupEvents, events.data]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const month = financeToday.slice(0, 7);
      const csv = await buildQuery<string>({ serverUrl, token, demo, endpoint: '/api/v1/report.csv', method: 'GET', params: { month } });
      if (csv && FileSystem.cacheDirectory) {
        const file = `${FileSystem.cacheDirectory}darkfinances-${month}.csv`;
        await FileSystem.writeAsStringAsync(file, csv, { encoding: FileSystem.EncodingType.UTF8 });
        try {
          await Share.share({ url: file, title: `DarkFinances ${month}` });
        } finally {
          await FileSystem.deleteAsync(file, { idempotent: true });
        }
      }
      else Alert.alert('Export', 'Nothing to export for this month.');
    } catch (e: any) {
      haptics.warning();
      Alert.alert('Export failed', e?.error || e?.message || 'Could not build the report.');
    } finally {
      setExporting(false);
    }
  };

  const openDetail = (t: Transaction) => {
    if (categorizeAction.isLocked) return;
    router.push({
      pathname: '/transaction/[id]',
      params: {
        id: t.id,
        payee: t.payee || '',
        amount: String(t.amount),
        date: t.date,
        account: t.account,
        accountId: t.accountId,
        category: t.category || '',
        categoryId: t.categoryId || '',
        notes: t.notes || '',
        isLeg: t.isLeg ? '1' : '',
        parentId: t.parentId || '',
        cleared: t.cleared === false ? '0' : '1',
        isSplit: t.isSplit ? '1' : '',
        splitCount: t.splitCount ? String(t.splitCount) : '',
        imported: t.imported ? '1' : '',
      },
    });
  };

  const applyCategory = (categoryId: string) => {
    if (!categorizing || categorizeAction.isLocked) return;
    categorizeAction.run(
      {
        id: categorizing.id,
        categoryId,
        isLeg: !!categorizing.isLeg,
        parentId: categorizing.parentId || null,
        accountId: categorizing.accountId,
        date: categorizing.date,
      },
      { onSuccess: () => setCategorizing(null) },
    );
  };

  const openEventGroup = (item: EventGroupRow) => {
    if (categorizeAction.isLocked) return;
    haptics.tap();
    router.push({ pathname: '/tag/[tag]', params: { tag: `ev-${item.slug}` } });
  };

  const renderItem = ({ item }: { item: ActivityRow }) => {
    const navLocked = categorizeAction.isLocked;
    if ('isEventGroup' in item) {
      return (
        <Pressable
          testID={`activity-event-row-${item.slug}`}
          style={({ pressed }) => [styles.row, pressed && !navLocked && styles.rowPressed, navLocked && { opacity: 0.55 }]}
          disabled={navLocked}
          onPress={() => openEventGroup(item)}
        >
          <Avatar label={item.name} size={38} />
          <View style={styles.mid}>
            <View style={styles.payeeLine}>
              <Text style={[styles.payee, { flexShrink: 1 }]} numberOfLines={1}>{item.name}</Text>
              <SplitPill count={item.count} />
            </View>
            <Text style={styles.account} numberOfLines={1}>
              {item.count} grouped expense{item.count === 1 ? '' : 's'} · {fmtDay(item.firstDate)}-{fmtDay(item.lastDate)}
            </Text>
          </View>
          <Text style={[styles.amt, { color: colors.text }]}>{fmtMoney(-item.spend)}</Text>
        </Pressable>
      );
    }
    const income = item.amount > 0;
    const row = (
      <Pressable
        testID={`activity-transaction-${item.id}`}
        style={({ pressed }) => [styles.row, pressed && !navLocked && styles.rowPressed, navLocked && { opacity: 0.55 }]}
        onPress={() => openDetail(item)}
        disabled={navLocked}
      >
        <Avatar label={item.payee} category={item.isSplit ? undefined : item.category ?? undefined} size={38} />
        <View style={styles.mid}>
          <View style={styles.payeeLine}>
            <Text style={[styles.payee, { flexShrink: 1 }]} numberOfLines={1}>{item.payee || '—'}</Text>
            {item.cleared === false ? <PendingPill /> : null}
            {item.isSplit ? <SplitPill count={item.splitCount} /> : null}
          </View>
          <Text style={styles.account} numberOfLines={1}>
            {item.account}
            {item.isSplit ? ` · Split into ${item.splitCount ?? 2}` : item.category ? ` · ${item.category}` : ' · uncategorized'}
          </Text>
        </View>
        <Text style={[styles.amt, { color: income ? colors.green : colors.text }]}>
          {income ? '+' : ''}{fmtMoney(item.amount)}
        </Text>
      </Pressable>
    );
    // Splits carry per-leg categories, so the quick single-category swipe doesn't apply.
    if (item.isSplit || navLocked) return row;
    return (
      <Swipeable
        enabled={!navLocked}
        renderRightActions={(_prog, _drag, swipeable) => (
          <Pressable
            style={styles.swipeCat}
            disabled={navLocked}
            onPress={() => { swipeable?.close(); haptics.tap(); setCategorizing(item); }}
          >
            <Text style={styles.swipeCatText}>{item.category ? 'Recategorize' : 'Categorize'}</Text>
          </Pressable>
        )}
        overshootRight={false}
        friction={2}
        rightThreshold={36}
      >
        {row}
      </Swipeable>
    );
  };

  return (
    <View style={styles.root} testID="activity-screen">
      <MutationLiveRegion message={categorizeAction.announce} />
      <MutationFormBanner outcome={categorizeAction.outcome} onRetry={categorizeAction.retry} onRefetch={onRefresh} />
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <Text style={styles.title}>Activity</Text>
        <Pressable testID="activity-export-button" onPress={exportCsv} disabled={exporting} style={({ pressed }) => [styles.exportBtn, pressed && { opacity: 0.7 }]}>
          <Text style={styles.exportText}>{exporting ? 'Exporting…' : 'Export'}</Text>
        </Pressable>
      </View>
      <View style={styles.controls}>
        <TextInput
          testID="activity-search-input"
          style={styles.search}
          value={search}
          onChangeText={setSearch}
          placeholder="Search all transactions…"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
        />
        <View style={styles.filters}>
          {(['all', 'expense', 'income'] as Filter[]).map((f) => (
            <Pressable testID={`activity-filter-${f}${filter === f ? '-selected' : ''}`} key={f} onPress={() => { haptics.tap(); setFilter(f); }} style={[styles.fbtn, filter === f && styles.fbtnActive]}>
              <Text style={[styles.fbtnText, filter === f && styles.fbtnTextActive]}>{f === 'all' ? 'All' : f === 'expense' ? 'Out' : 'In'}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsScroll} contentContainerStyle={styles.chipsRow}>
        {!searching ? (
          <>
            {RANGES.map((r) => (
              <Pressable testID={`activity-range-${r.label.toLowerCase()}${rangeM === r.m ? '-selected' : ''}`} key={r.label} onPress={() => { haptics.tap(); setRangeM(r.m); }} style={[styles.chip, rangeM === r.m && styles.chipActive]}>
                <Text style={[styles.chipText, rangeM === r.m && styles.chipTextActive]}>{r.label}</Text>
              </Pressable>
            ))}
            <View style={styles.chipDivider} />
          </>
        ) : null}
        <Pressable testID={`activity-uncategorized${uncatOnly ? '-selected' : ''}`} onPress={() => { haptics.tap(); setUncatOnly((v) => !v); }} style={[styles.chip, uncatOnly && styles.chipActive]}>
          <Text style={[styles.chipText, uncatOnly && styles.chipTextActive]}>Uncategorized</Text>
        </Pressable>
        {!searching ? (
          <Pressable testID={`activity-group-events${groupEvents ? '-selected' : ''}`} onPress={() => { haptics.tap(); setGroupEvents((v) => !v); }} style={[styles.chip, groupEvents && styles.chipActive]}>
            <Text style={[styles.chipText, groupEvents && styles.chipTextActive]}>Group trips</Text>
          </Pressable>
        ) : null}
        <View style={styles.chipDivider} />
        <Pressable testID={`activity-account-all${accountId === null ? '-selected' : ''}`} onPress={() => { haptics.tap(); setAccountId(null); }} style={[styles.chip, accountId === null && styles.chipActive]}>
          <Text style={[styles.chipText, accountId === null && styles.chipTextActive]}>All accounts</Text>
        </Pressable>
        {(accounts.data ?? []).map((a) => (
          <Pressable testID={`activity-account-${a.id}${accountId === a.id ? '-selected' : ''}`} key={a.id} onPress={() => { haptics.tap(); setAccountId(a.id); }} style={[styles.chip, accountId === a.id && styles.chipActive]}>
            <Text style={[styles.chipText, accountId === a.id && styles.chipTextActive]} numberOfLines={1}>{a.name}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {searching ? (
        <Text style={styles.searchHint}>
          {listPending
            ? 'Searching all time…'
            : searchRes.isLoading && !searchRes.data
              ? 'Searching all time…'
              : `${searchRes.data?.total ?? 0} match${(searchRes.data?.total ?? 0) === 1 ? '' : 'es'} all-time${searchRes.data?.truncated ? ' · showing first 200' : ''}`}
        </Text>
      ) : null}

      {!loading && !fatal ? (
        <QueryRefetchBanners queries={activityRefetchQueries} testID="activity-refetch-banner" />
      ) : null}

      {loading ? (
        <View style={{ padding: 16 }}>
          <SkeletonList rows={8} />
        </View>
      ) : fatal ? (
        <ErrorState error={queryErrorMessage(listQuery.error)} onRetry={onRefresh} />
      ) : (
        <SectionList
          style={styles.list}
          sections={sections}
          keyExtractor={(t) => t.id}
          renderItem={({ item }) => renderItem({ item })}
          renderSectionHeader={({ section }) => <Text style={styles.sectionHeader}>{section.title}</Text>}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{ paddingBottom: 96 }}
          ListEmptyComponent={<Text style={styles.empty}>{searching ? 'No matches' : 'No transactions in range'}</Text>}
          refreshControl={<GestureRefreshControl onRefresh={onRefresh} />}
        />
      )}

      <Pressable
        testID="activity-add-transaction-button"
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
        onPress={() => { haptics.tap(); router.push('/add-transaction'); }}
        accessibilityLabel="Add transaction"
      >
        <Text style={styles.fabPlus}>+</Text>
      </Pressable>

      <Modal visible={!!categorizing} animationType="slide" transparent onRequestClose={() => { if (!categorizeAction.isLocked) setCategorizing(null); }}>
        <Pressable style={styles.modalBg} onPress={() => { if (!categorizeAction.isLocked) setCategorizing(null); }} disabled={categorizeAction.isLocked}>
          <View testID="activity-category-sheet" style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.sheetTitle}>Categorize</Text>
            <Text style={styles.sheetSub} numberOfLines={1}>{categorizing?.payee || '—'} · {categorizing ? fmtMoney(categorizing.amount) : ''}</Text>
            <FlatList
              data={categories.data ?? []}
              keyExtractor={(c) => c.id}
              style={{ maxHeight: 420 }}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <Pressable testID={`activity-category-option-${item.id}`} style={({ pressed }) => [styles.catOption, pressed && { opacity: 0.6 }]} onPress={() => applyCategory(item.id)} disabled={categorizeAction.isLocked}>
                  <Text style={styles.catOptionText}>{item.name}</Text>
                  <Text style={styles.catOptionGroup}>{item.group}</Text>
                </Pressable>
              )}
            />
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.text, fontSize: 17, fontWeight: '700' },
  exportBtn: { backgroundColor: colors.surface2, borderColor: colors.border, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  exportText: { color: colors.accentLight, fontSize: 13, fontWeight: '600' },
  searchHint: { color: colors.muted, fontSize: 12, paddingHorizontal: 16, paddingBottom: 8 },
  controls: { padding: 12, gap: 10, flexDirection: 'row', alignItems: 'center' },
  search: { flex: 1, backgroundColor: colors.surface2, borderColor: colors.border, borderWidth: 1, borderRadius: 8, color: colors.text, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
  filters: { flexDirection: 'row', gap: 4 },
  fbtn: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 7, borderWidth: 1, borderColor: colors.border },
  fbtnActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  fbtnText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  fbtnTextActive: { color: '#fff' },
  chipsScroll: { flexGrow: 0, flexShrink: 0 },
  chipsRow: { gap: 8, paddingHorizontal: 12, paddingBottom: 10, alignItems: 'center' },
  list: { flex: 1 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2, maxWidth: 180 },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: '#fff' },
  chipDivider: { width: 1, height: 22, backgroundColor: colors.border, marginHorizontal: 2 },
  sectionHeader: { color: colors.muted, fontSize: 12, fontWeight: '700', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6, backgroundColor: colors.bg },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 16, backgroundColor: colors.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowPressed: { backgroundColor: colors.surface2 },
  mid: { flex: 1, minWidth: 0 },
  payeeLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  payee: { color: colors.text, fontSize: 14, fontWeight: '500' },
  account: { color: colors.muted, fontSize: 11, marginTop: 1 },
  amt: { fontSize: 14, fontWeight: '700', minWidth: 92, textAlign: 'right' },
  swipeCat: { backgroundColor: colors.accent, justifyContent: 'center', alignItems: 'center', width: 124, paddingHorizontal: 12 },
  swipeCatText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  empty: { color: colors.muted, textAlign: 'center', padding: 40 },
  fab: { position: 'absolute', right: 18, bottom: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 6 },
  fabPressed: { opacity: 0.85, transform: [{ scale: 0.96 }] },
  fabPlus: { color: '#fff', fontSize: 30, fontWeight: '700', marginTop: -2 },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16 },
  sheetTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  sheetSub: { color: colors.muted, fontSize: 12, marginTop: 4, marginBottom: 10 },
  catOption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  catOptionText: { color: colors.text, fontSize: 15 },
  catOptionGroup: { color: colors.muted, fontSize: 12 },
});

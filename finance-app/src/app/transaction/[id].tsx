import React, { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { SymbolView, SymbolViewProps } from 'expo-symbols';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useAddReceipt,
  useAddReimbLink,
  useCategories,
  useDeleteReceipt,
  useDeleteReimbLink,
  useDeleteTransaction,
  useEvents,
  useMarkRecurring,
  useMerchantHistory,
  useReceiptImageSource,
  useReceipts,
  useRecurring,
  useReimbLinks,
  useSaveRule,
  useSearch,
  useSetCategory,
  useSetDate,
  useSetNotes,
  useSetPayee,
  useTags,
  useTransaction,
} from '@/api/hooks/finance.hooks';
import { ReimbTxnRef, Transaction } from '@/api/generated/types';
import { Card, CardTitle, TagChips } from '@/components/ui';
import { haptics } from '@/lib/haptics';
import { CapturedReceipt, pickReceiptFromLibrary, saveReceiptLocal, scanReceiptFromCamera } from '@/lib/receipts';
import { categoryIcon } from '@/theme/categoryIcons';
import { cadenceLabel, colors, dueLabel, fmtDay, fmtMoney, fmtPos, monthLabel, NoteTag, parseNoteTags, tagKind, toTagToken } from '@/theme/colors';

const norm = (s: string) =>
  (s || '').toLowerCase().replace(/[#*]?\d{3,}/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const pad2 = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseYmd = (s: string) => {
  const [y, m, d] = (s || '').split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d) : new Date();
};
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtMenuDay = (d: string) => {
  if (!d) return 'Pick date';
  const [y, m, day] = d.split('-').map(Number);
  if (!y || !m || !day) return d;
  return new Date(y, m - 1, day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};

export default function TransactionDetail() {
  const p = useLocalSearchParams<{
    id: string; payee: string; amount: string; date: string; account: string; accountId: string;
    category: string; categoryId: string; notes: string; isLeg: string; parentId: string; cleared: string;
    isSplit: string; splitCount: string; imported: string;
  }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const categories = useCategories();
  const recurring = useRecurring();
  const setCategory = useSetCategory();
  const setNotes = useSetNotes();
  const saveRule = useSaveRule();
  const markRec = useMarkRecurring();
  const del = useDeleteTransaction();
  const setPayee = useSetPayee();
  const setDate = useSetDate();

  const isLeg = p.isLeg === '1';
  const isSplit = p.isSplit === '1';
  const amount = Number(p.amount) || 0;
  const income = amount > 0;
  const pending = p.cleared === '0'; // cleared:false = bank hasn't posted it yet
  // Only user-created rows are deletable — bank-imported ones aren't (Rocket Money parity).
  const canDelete = !isLeg && p.imported !== '1';

  // For a split, pull the legs so we can show them and route to the editor.
  const detail = useTransaction(isSplit ? p.id : undefined, p.accountId, p.date);
  const splitLegs = detail.data?.legs ?? [];
  const splitCount = Number(p.splitCount) || splitLegs.length;
  const goSplit = () => {
    haptics.tap();
    router.push({ pathname: '/split/[id]', params: { id: p.id, accountId: p.accountId, date: p.date } });
  };

  const [payeeName, setPayeeNameLocal] = useState(p.payee || '');
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState(p.payee || '');
  const [dating, setDating] = useState(false);
  const [txnDate, setTxnDate] = useState(p.date || '');
  const [dateText, setDateText] = useState(p.date || ymd(new Date()));
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = parseYmd(p.date || ymd(new Date()));
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [monthPicking, setMonthPicking] = useState(false);
  const [category, setCategoryName] = useState(p.category || '');
  const [categoryId, setCategoryId] = useState(p.categoryId || '');
  const parsedNotes = useMemo(() => parseNoteTags(p.notes), [p.notes]);
  const [noteText, setNoteText] = useState(parsedNotes.text);
  const [tags, setTags] = useState<NoteTag[]>(parsedNotes.tags);
  const [tagInput, setTagInput] = useState('');
  const [showTags, setShowTags] = useState(parsedNotes.tags.length > 0);
  const [showNotes, setShowNotes] = useState(!!parsedNotes.text);
  // Baselines move forward on save so the Save button only shows real changes.
  const [baseText, setBaseText] = useState(parsedNotes.text);
  const [baseRaws, setBaseRaws] = useState<string[]>(parsedNotes.tags.map((t) => t.raw));
  // Tags present at load may drive attribution — confirm before removing.
  const originalRaws = useRef(new Set(parsedNotes.tags.map((t) => t.raw.toLowerCase()))).current;
  const allTags = useTags();
  const [picking, setPicking] = useState(false);
  const [linking, setLinking] = useState(false);
  const [linkQuery, setLinkQuery] = useState('');
  const currentDate = txnDate || p.date || '';

  const links = useReimbLinks(p.id);
  const addLink = useAddReimbLink();
  const delLink = useDeleteReimbLink();
  const search = useSearch(linkQuery);

  const thisRef: ReimbTxnRef = { id: p.id, date: currentDate || null, payee: p.payee || '', amount };
  // For an inflow we show the expenses it repays; for an expense, the inflows that repaid it.
  const linked = (income ? links.data?.asInflow : links.data?.asExpense) ?? [];
  // The picker lists the opposite sign: an inflow links to expenses, vice versa.
  const candidates = (search.data?.transactions ?? []).filter((t) => t.id !== p.id && (income ? t.amount < 0 : t.amount > 0));

  const openTxn = (t: ReimbTxnRef) =>
    router.push({
      pathname: '/transaction/[id]',
      params: { id: t.id, payee: t.payee, amount: String(t.amount), date: t.date ?? '', account: '', accountId: '', category: '', categoryId: '', notes: '', isLeg: '0', parentId: '' },
    });

  const createLink = (t: Transaction) => {
    const ref: ReimbTxnRef = { id: t.id, date: t.date, payee: t.payee, amount: t.amount };
    const vars = income ? { inflow: thisRef, expense: ref } : { inflow: ref, expense: thisRef };
    addLink.mutate(vars, { onSuccess: () => { setLinking(false); setLinkQuery(''); } });
  };
  const removeLink = (other: ReimbTxnRef) =>
    delLink.mutate(income ? { inflowId: p.id, expenseId: other.id } : { inflowId: other.id, expenseId: p.id });

  const sub = (recurring.data?.items ?? []).find((i) => norm(p.payee) === i.key || norm(p.payee).includes(i.key));

  const pickCategory = (cid: string, categoryName: string) => {
    setCategory.mutate({ id: p.id, categoryId: cid, isLeg, parentId: p.parentId || null, accountId: p.accountId, date: currentDate });
    setCategoryName(categoryName);
    setCategoryId(cid);
    setPicking(false);
  };

  // --- Rules, mark-as-recurring (power features). Splitting lives on its own screen.
  const canSplit = !isLeg && !isSplit && !!p.accountId && !!currentDate && amount !== 0;
  const canMarkRecurring = !isLeg && amount < 0 && !!p.payee && !sub;

  const applyRuleForPayee = () => {
    if (!categoryId) return;
    saveRule.mutate(
      { match: p.payee, categoryId, categoryName: category },
      {
        onSuccess: (r) =>
          Alert.alert(
            'Rule saved',
            `“${p.payee}” will always be categorized as ${category}.` +
              (r?.applied ? `\n\nApplied to ${r.applied} past transaction${r.applied === 1 ? '' : 's'}.` : ''),
          ),
        onError: (e) => Alert.alert('Could not save rule', e.error || 'Please try again.'),
      }
    );
  };
  const doMarkRecurring = () => {
    markRec.mutate(
      { payee: p.payee },
      {
        onSuccess: () => Alert.alert('Marked as recurring', `“${p.payee}” will appear in Subscriptions once it has at least two charges.`),
        onError: (e) => Alert.alert('Could not mark recurring', e.error || 'Please try again.'),
      }
    );
  };
  const doDelete = () => {
    haptics.warning();
    Alert.alert(
      'Delete transaction?',
      pending
        ? 'This looks like a pending charge that never posted. Deleting removes it from your ledger and corrects your balance. This can’t be undone.'
        : 'This permanently removes it from your ledger and adjusts your balance. This can’t be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            del.mutate(
              { id: p.id, accountId: p.accountId, date: currentDate },
              {
                onSuccess: () => { haptics.success(); router.back(); },
                onError: (e) => Alert.alert('Could not delete', e.error || 'Please try again.'),
              }
            ),
        },
      ]
    );
  };
  // Receipts — scan/attach, view full-screen, delete. OCR runs on-device (Vision).
  const receipts = useReceipts(p.id);
  const addReceipt = useAddReceipt();
  const delReceipt = useDeleteReceipt();
  const receiptSource = useReceiptImageSource();
  const receiptList = receipts.data?.receipts ?? [];
  const [scanning, setScanning] = useState(false);
  const [viewerId, setViewerId] = useState<string | null>(null);

  const uploadCapture = (cap: CapturedReceipt | null) => {
    if (!cap) { setScanning(false); return; }
    if (!cap.base64) { setScanning(false); Alert.alert('Could not read image', 'Please try again.'); return; }
    addReceipt.mutate(
      { txnId: p.id, imageBase64: cap.base64, mime: cap.mime, ocrText: cap.ocrText, ocrLines: cap.ocrLines, amount: cap.amount, date: cap.date, source: cap.source ?? 'camera' },
      {
        onSuccess: async (rec) => { if (rec?.id) await saveReceiptLocal(cap.uri, rec.id); setScanning(false); haptics.success(); },
        onError: (e) => { setScanning(false); Alert.alert('Upload failed', e.error || 'Please try again.'); },
      }
    );
  };
  const startScan = () => {
    if (scanning) return;
    haptics.tap();
    Alert.alert('Add receipt', 'Text is read on-device — nothing leaves your phone until you save.', [
      { text: 'Take Photo', onPress: async () => { setScanning(true); try { uploadCapture(await scanReceiptFromCamera()); } catch (e: any) { setScanning(false); Alert.alert('Camera unavailable', e?.message || 'Please try again.'); } } },
      { text: 'Choose from Library', onPress: async () => { setScanning(true); try { uploadCapture(await pickReceiptFromLibrary()); } catch (e: any) { setScanning(false); Alert.alert('Library unavailable', e?.message || 'Please try again.'); } } },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };
  const removeReceipt = (id: string) => {
    Alert.alert('Delete receipt', 'Remove this receipt image?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => delReceipt.mutate({ id }, { onSuccess: () => { setViewerId(null); haptics.success(); } }) },
    ]);
  };

  // See History (N) — merchant monthly history. Shared query key with the merchant
  // screen, so tapping through reuses the cache.
  const canHistory = !!payeeName;
  const mhist = useMerchantHistory(canHistory ? payeeName : undefined, 12);
  const histCount = mhist.data?.count;
  const goHistory = () => { haptics.tap(); router.push({ pathname: '/merchant/[name]', params: { name: payeeName } }); };

  // Move to Reimbursements — file an expense someone else pays under the
  // Reimbursement category so it leaves personal spending and shows as owed.
  const reimbCat = (categories.data ?? []).find((c) => /^reimbursement$/i.test(c.name));
  const canMoveReimb = !isLeg && !isSplit && amount < 0 && !!reimbCat && categoryId !== reimbCat.id;
  const moveToReimb = () => {
    if (!reimbCat) return;
    haptics.tap();
    setCategory.mutate(
      { id: p.id, categoryId: reimbCat.id, isLeg, parentId: p.parentId || null, accountId: p.accountId, date: currentDate },
      { onSuccess: () => haptics.success(), onError: (e) => Alert.alert('Could not move', e.error || 'Please try again.') }
    );
    setCategoryName(reimbCat.name);
    setCategoryId(reimbCat.id);
  };

  // Change date — dating a refund back to the purchase month makes it net that
  // month's spending. Split legs follow their parent, so only non-legs qualify.
  const canEditDate = !isLeg && !!p.id;
  const lastMonthLastDay = () => {
    const now = new Date();
    return ymd(new Date(now.getFullYear(), now.getMonth(), 0));
  };
  const openDate = () => {
    const current = currentDate || ymd(new Date());
    const d = parseYmd(current);
    setDateText(current);
    setCalendarMonth(new Date(d.getFullYear(), d.getMonth(), 1));
    setMonthPicking(false);
    setDating(true);
    haptics.tap();
  };
  const doSetDate = (picked?: string) => {
    const next = (picked || dateText || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) { Alert.alert('Invalid date', 'Use the format YYYY-MM-DD, e.g. 2026-06-30.'); return; }
    if (next === currentDate) { setDating(false); return; }
    setDate.mutate(
      { id: p.id, date: next, isLeg },
      {
        onSuccess: () => { haptics.success(); setTxnDate(next); setDateText(next); setDating(false); },
        onError: (e) => { setDateText(currentDate || ymd(new Date())); Alert.alert('Could not change date', e.error || 'Please try again.'); },
      }
    );
  };

  const canRename = !isLeg;
  const openRename = () => { setRenameText(payeeName); setRenaming(true); haptics.tap(); };
  const doRename = () => {
    const next = renameText.trim();
    setRenaming(false);
    if (next === payeeName) return;
    const prev = payeeName;
    setPayeeNameLocal(next); // optimistic
    setPayee.mutate(
      { id: p.id, payee: next, isLeg, parentId: p.parentId || null, accountId: p.accountId, date: currentDate },
      { onSuccess: () => haptics.success(), onError: (e) => { setPayeeNameLocal(prev); Alert.alert('Could not rename', e.error || 'Please try again.'); } }
    );
  };

  // Notes text + #tags both serialize into the single notes field, so save them
  // together. Recombine human text with the (now editable) tag set.
  const rawsOf = (list: NoteTag[]) => list.map((t) => t.raw);
  const sameRaws = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const dirty = noteText.trim() !== baseText || !sameRaws(rawsOf(tags), baseRaws);
  const recombineNotes = () => [noteText.trim(), ...tags.map((t) => t.raw)].join(' ').replace(/\s{2,}/g, ' ').trim();
  const save = () =>
    setNotes.mutate(
      { id: p.id, notes: recombineNotes(), isLeg, parentId: p.parentId || null, accountId: p.accountId, date: currentDate },
      { onSuccess: () => { setBaseText(noteText.trim()); setBaseRaws(rawsOf(tags)); } }
    );

  const addTag = (input: string) => {
    const token = toTagToken(input);
    setTagInput('');
    if (!token) return;
    const raw = `#${token}`;
    if (tags.some((t) => t.raw.toLowerCase() === raw.toLowerCase())) return;
    const kind = tagKind(token);
    setTags([...tags, { raw, label: kind === 'event' ? token.replace(/^ev-/i, '') : token, kind }]);
    haptics.tap();
  };
  const removeTag = (raw: string) => {
    const doRemove = () => { setTags(tags.filter((t) => t.raw !== raw)); haptics.tap(); };
    if (originalRaws.has(raw.toLowerCase())) {
      Alert.alert(
        'Remove tag?',
        `"${raw}" may be used for reimbursement or event tracking. Remove it from this transaction?`,
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: doRemove }]
      );
    } else doRemove();
  };
  const tagSuggestions = (allTags.data?.tags ?? [])
    .filter((s) => !tags.some((t) => t.raw.toLowerCase() === s.raw.toLowerCase()))
    .filter((s) => { const q = toTagToken(tagInput); return !q || s.token.toLowerCase().includes(q); })
    .slice(0, 8);

  // One-tap "assign to trip": surface trips whose #ev tag isn't already on this txn.
  const events = useEvents();
  const eventChips = (events.data?.events ?? [])
    .filter((e) => !tags.some((t) => t.raw.toLowerCase() === `#ev-${e.slug}`.toLowerCase()))
    .slice(0, 6);
  const selectedDay = dateText && /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? dateText : currentDate;
  const selectedMonthKey = ymd(calendarMonth).slice(0, 7);
  const todayKey = ymd(new Date());
  const calendarDays = useMemo(() => {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const firstWeekday = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells: Array<string | null> = Array(firstWeekday).fill(null);
    for (let day = 1; day <= daysInMonth; day += 1) cells.push(ymd(new Date(year, month, day)));
    while (cells.length % 7) cells.push(null);
    return cells;
  }, [calendarMonth]);
  const changeCalendarMonth = (delta: number) => {
    setMonthPicking(false);
    setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + delta, 1));
    haptics.tap();
  };
  const pickShortcutDate = (next: string) => {
    const d = parseYmd(next);
    setDateText(next);
    setCalendarMonth(new Date(d.getFullYear(), d.getMonth(), 1));
    doSetDate(next);
  };
  const catMeta = categoryIcon(category || payeeName);
  const heroBg = income ? '#214d36' : '#733e2d';

  return (
    <ScrollView
      testID="transaction-detail-screen"
      style={styles.root}
      contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <Stack.Screen
        options={{
          headerShown: false,
        }}
      />

      <View style={[styles.menuHero, { backgroundColor: heroBg, paddingTop: insets.top + 14 }]}>
        <View style={styles.menuTopBar}>
          <Pressable onPress={save} disabled={!dirty || setNotes.isPending} hitSlop={8} style={styles.topSide}>
            {dirty ? <Text style={styles.headerSave}>{setNotes.isPending ? 'Saving…' : 'Save'}</Text> : null}
          </Pressable>
          {canEditDate ? (
            <Pressable testID="transaction-date-button" onPress={openDate} hitSlop={8} style={({ pressed }) => [styles.topDateBtn, pressed && { opacity: 0.65 }]}>
              <Text style={styles.topDate}>{fmtMenuDay(currentDate)}</Text>
              <SymbolView name="chevron.down" tintColor={colors.text} size={11} resizeMode="scaleAspectFit" />
            </Pressable>
          ) : (
            <Text style={styles.topDate}>{fmtMenuDay(currentDate)}</Text>
          )}
          <Pressable onPress={() => router.back()} hitSlop={10} style={({ pressed }) => [styles.topSide, styles.closeBtn, pressed && { opacity: 0.65 }]}>
            <SymbolView name="xmark" tintColor={colors.text} size={18} resizeMode="scaleAspectFit" />
          </Pressable>
        </View>
        {pending ? (
          <View style={styles.pendingBubble}>
            <Text style={styles.pendingBubbleText}>Pending Transaction</Text>
          </View>
        ) : null}
        {canRename ? (
          <Pressable onPress={openRename} hitSlop={8} style={({ pressed }) => pressed && { opacity: 0.6 }}>
            <Text style={styles.payee}>{payeeName || 'Add name'}</Text>
          </Pressable>
        ) : (
          <Text style={styles.payee}>{payeeName || '—'}</Text>
        )}
        <Text style={[styles.amount, { color: colors.text }]}>{income ? '+' : ''}{fmtMoney(amount)}</Text>
        {p.payee ? (
          <View style={styles.statementBlock}>
            <Text style={styles.statementLabel}>Statement Description</Text>
            <Text style={styles.statementText}>{String(p.payee).toUpperCase()}</Text>
          </View>
        ) : null}
        {!isSplit ? (
          <Pressable testID="transaction-category-pill" onPress={() => { haptics.tap(); setPicking(true); }} style={({ pressed }) => [styles.categoryPill, pressed && { opacity: 0.75 }]}>
            <SymbolView name={catMeta.symbol} tintColor={catMeta.color} size={16} resizeMode="scaleAspectFit" />
            <Text style={styles.categoryPillText}>{category || 'Uncategorized'}</Text>
            <SymbolView name="chevron.down" tintColor={colors.text} size={10} resizeMode="scaleAspectFit" />
          </Pressable>
        ) : (
          <View testID="transaction-category-pill" style={styles.categoryPill}>
            <SymbolView name="arrow.triangle.branch" tintColor={colors.text} size={16} resizeMode="scaleAspectFit" />
            <Text style={styles.categoryPillText}>Split transaction</Text>
          </View>
        )}
      </View>

      <View style={styles.menuBody}>
      {sub ? (
        <Pressable onPress={() => router.push(`/recurring/${encodeURIComponent(sub.key)}`)} style={({ pressed }) => pressed && { opacity: 0.7 }}>
          <View style={styles.subBanner}>
            <Text style={styles.subText}>
              Part of a subscription · {cadenceLabel(sub.cadence)}
              {sub.status === 'active' ? ` · next ${dueLabel(sub.nextRenewal)}` : ''}
            </Text>
            <Text style={styles.subArrow}>›</Text>
          </View>
        </Pressable>
      ) : null}

      <MenuGroup testID="transaction-action-menu">
        {canRename ? <MenuActionRow icon="pencil" label="Rename" onPress={openRename} /> : null}
        <MenuSwitchRow
          icon="arrow.clockwise.circle"
          label="Is Recurring?"
          value={!!sub}
          disabled={!!sub || !canMarkRecurring || markRec.isPending}
          onValueChange={() => {
            if (sub) router.push(`/recurring/${encodeURIComponent(sub.key)}`);
            else if (canMarkRecurring) doMarkRecurring();
          }}
        />
        {canMoveReimb ? (
          <MenuActionRow
            icon="person.2.fill"
            label="Move to Reimbursements"
            right={setCategory.isPending ? 'Moving…' : 'Not personal spend'}
            onPress={moveToReimb}
            disabled={setCategory.isPending}
            last
          />
        ) : (
          <MenuActionRow icon="nosign" label={income ? 'Deposit' : 'Personal spend'} right="Included" disabled last />
        )}
      </MenuGroup>

      <MenuGroup>
        <MenuActionRow
          icon="tag"
          label={tags.length ? `Tags (${tags.length})` : 'Add Tags'}
          onPress={() => { setShowTags(!showTags); haptics.tap(); }}
        />
        <MenuActionRow
          icon="note.text"
          label={noteText.trim() ? 'Edit Note' : 'Add Note'}
          onPress={() => { setShowNotes(!showNotes); haptics.tap(); }}
        />
        {!isLeg && categoryId ? (
          <MenuActionRow
            icon="bolt.circle"
            label="Create Rule"
            right={saveRule.isPending ? 'Saving…' : category}
            onPress={applyRuleForPayee}
            disabled={saveRule.isPending}
          />
        ) : null}
        {canSplit ? (
          <MenuActionRow icon="arrow.triangle.branch" label="Split" onPress={goSplit} />
        ) : null}
        <MenuActionRow icon="doc.viewfinder" label={receiptList.length ? `Receipts (${receiptList.length})` : 'Add Receipt'} onPress={startScan} disabled={scanning} last />
      </MenuGroup>

      <CardTitle style={styles.sectionTitle}>{income ? 'Repayment for' : 'Repaid by'}</CardTitle>
      <Card style={styles.list}>
        {linked.length ? (
          linked.map((t) => (
            <View key={t.id} style={styles.linkRow}>
              <Pressable style={({ pressed }) => [styles.linkMain, pressed && { opacity: 0.6 }]} onPress={() => openTxn(t)}>
                <Text style={styles.linkPayee} numberOfLines={1}>{t.payee || '(no payee)'}</Text>
                <Text style={styles.linkSub}>{t.date ? fmtDay(t.date) : ''} · {fmtPos(Math.abs(t.amount))}</Text>
              </Pressable>
              <Pressable hitSlop={10} onPress={() => removeLink(t)} disabled={delLink.isPending} style={({ pressed }) => pressed && { opacity: 0.5 }}>
                <Text style={styles.unlink}>Unlink</Text>
              </Pressable>
            </View>
          ))
        ) : (
          <Text style={styles.linkEmpty}>{income ? 'Not linked to any expense yet.' : 'No linked repayment yet.'}</Text>
        )}
        <Pressable style={({ pressed }) => [styles.linkBtn, pressed && { opacity: 0.6 }]} onPress={() => { haptics.tap(); setLinking(true); }}>
          <Text style={styles.linkBtnText}>{income ? '+ Link to an expense' : '+ Link a repayment'}</Text>
        </Pressable>
      </Card>

      {isSplit ? (
        <>
          <CardTitle style={styles.sectionTitle}>Split into {splitCount}</CardTitle>
          <Card style={styles.list}>
            {splitLegs.length ? (
              splitLegs.map((l, i) => (
                <View key={l.id ?? i} style={styles.legInfoRow}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.legInfoName} numberOfLines={1}>{l.name || l.category || 'Uncategorized'}</Text>
                    {l.name && l.category ? <Text style={styles.legInfoSub} numberOfLines={1}>{l.category}</Text> : null}
                  </View>
                  <Text style={styles.legInfoAmt}>{fmtPos(Math.abs(l.amount))}</Text>
                </View>
              ))
            ) : (
              <Text style={styles.linkEmpty}>{detail.isLoading ? 'Loading…' : 'No legs found.'}</Text>
            )}
            <Pressable style={({ pressed }) => [styles.linkBtn, pressed && { opacity: 0.6 }]} onPress={goSplit}>
              <Text style={styles.linkBtnText}>Edit split · {fmtPos(Math.abs(amount))} into {splitCount}</Text>
            </Pressable>
          </Card>
        </>
      ) : null}

      {showTags ? (
      <>
      <CardTitle style={styles.sectionTitle}>Tags</CardTitle>
      <Card>
        {tags.length ? (
          <TagChips
            tags={tags}
            style={{ marginBottom: 12 }}
            onPressTag={(raw) => router.push({ pathname: '/tag/[tag]', params: { tag: raw } })}
            onRemoveTag={removeTag}
          />
        ) : null}
        <View style={styles.tagAddRow}>
          <Text style={styles.tagHash}>#</Text>
          <TextInput
            style={styles.tagInput}
            value={tagInput}
            onChangeText={setTagInput}
            placeholder="Add a tag…"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => addTag(tagInput)}
          />
          {tagInput.trim() ? (
            <Pressable onPress={() => addTag(tagInput)} style={({ pressed }) => [styles.tagAddBtn, pressed && { opacity: 0.7 }]}>
              <Text style={styles.tagAddBtnText}>Add</Text>
            </Pressable>
          ) : null}
        </View>
        {tagSuggestions.length ? (
          <View style={styles.suggestRow}>
            {tagSuggestions.map((s) => (
              <Pressable key={s.raw} onPress={() => addTag(s.raw)} style={({ pressed }) => [styles.suggestChip, pressed && { opacity: 0.6 }]}>
                <Text style={styles.suggestText}>#{s.token}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {eventChips.length ? (
          <>
            <Text style={styles.tripLabel}>Add to a trip</Text>
            <View style={styles.suggestRow}>
              {eventChips.map((e) => (
                <Pressable key={e.slug} onPress={() => addTag(`ev-${e.slug}`)} style={({ pressed }) => [styles.tripChip, pressed && { opacity: 0.6 }]}>
                  <Text style={styles.tripChipText} numberOfLines={1}>{e.name}</Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}
        {tags.length ? <Text style={styles.tagHint}>Tap a tag to see everything with it.</Text> : null}
      </Card>
      </>
      ) : null}

      {showNotes ? (
      <>
      <CardTitle style={styles.sectionTitle}>Notes</CardTitle>
      <Card>
        <TextInput
          style={styles.notes}
          value={noteText}
          onChangeText={setNoteText}
          placeholder="Add a note…"
          placeholderTextColor={colors.muted}
          multiline
        />
      </Card>
      </>
      ) : null}

      {receiptList.length || scanning ? (
      <>
      <CardTitle style={styles.sectionTitle}>Receipts</CardTitle>
      <Card style={styles.list}>
        {/* Plain wrapping row — a horizontal ScrollView nested in the page's
            vertical ScrollView caused scroll/layout jank on New Arch. */}
        <View style={styles.receiptRow}>
          {receiptList.map((r) => (
            <Pressable key={r.id} onPress={() => { haptics.tap(); setViewerId(r.id); }} style={({ pressed }) => [styles.thumb, pressed && { opacity: 0.7 }]}>
              <Image source={receiptSource(r.id)} style={styles.thumbImg} contentFit="cover" transition={120} cachePolicy="memory-disk" />
              {r.amount != null ? <Text style={styles.thumbAmt}>{fmtPos(r.amount)}</Text> : null}
            </Pressable>
          ))}
          <Pressable onPress={startScan} disabled={scanning} style={({ pressed }) => [styles.thumbAdd, pressed && { opacity: 0.7 }, scanning && { opacity: 0.5 }]}>
            {scanning ? <ActivityIndicator color={colors.accentLight} /> : (
              <>
                <Text style={styles.thumbAddPlus}>+</Text>
                <Text style={styles.thumbAddText}>Scan</Text>
              </>
            )}
          </Pressable>
        </View>
        {receiptList.length === 0 && !scanning ? (
          <Text style={styles.receiptHint}>Scan a receipt to attach it here. Text is read on-device with Apple Vision.</Text>
        ) : null}
      </Card>
      </>
      ) : null}

      {canHistory ? (
        <Pressable onPress={goHistory} style={({ pressed }) => [styles.historyBtn, pressed && { opacity: 0.7 }]}>
          <Text style={styles.historyText}>See History{histCount != null ? ` (${histCount})` : ''}</Text>
          <Text style={styles.historyArrow}>›</Text>
        </Pressable>
      ) : null}

      <View style={styles.metaBlock}>
        {p.account ? (
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>Account</Text>
            <Text style={styles.metaValue}>{p.account}</Text>
          </View>
        ) : null}
        <View style={styles.metaItem}>
          <Text style={styles.metaLabel}>Other Dates</Text>
          <Text style={styles.metaMuted}>Transacted: {currentDate || 'Unknown'}</Text>
          <Text style={styles.metaMuted}>Posted: {currentDate || 'Unknown'}</Text>
        </View>
      </View>

      {canDelete ? (
        <Pressable
          onPress={doDelete}
          disabled={del.isPending}
          style={({ pressed }) => [styles.deleteBtn, del.isPending && { opacity: 0.5 }, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.deleteText}>{del.isPending ? 'Deleting…' : 'Delete transaction'}</Text>
        </Pressable>
      ) : null}

      </View>

      <Modal visible={picking} animationType="slide" transparent onRequestClose={() => setPicking(false)}>
        <Pressable style={styles.modalBg} onPress={() => setPicking(false)}>
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.sheetTitle}>Set category</Text>
            <FlatList
              data={categories.data ?? []}
              keyExtractor={(c) => c.id}
              style={{ maxHeight: 400 }}
              renderItem={({ item }) => (
                <Pressable style={({ pressed }) => [styles.catOption, pressed && { opacity: 0.6 }]} onPress={() => pickCategory(item.id, item.name)}>
                  <Text style={styles.catOptionText}>{item.name}</Text>
                  <Text style={styles.catOptionGroup}>{item.group}</Text>
                </Pressable>
              )}
            />
          </View>
        </Pressable>
      </Modal>

      <Modal visible={linking} animationType="slide" transparent onRequestClose={() => setLinking(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
          <Pressable style={styles.modalBg} onPress={() => setLinking(false)}>
            <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]} onPress={() => {}}>
              <Text style={styles.sheetTitle}>{income ? 'Pick the expense this repays' : 'Pick the repayment'}</Text>
              <TextInput
                style={styles.searchInput}
                value={linkQuery}
                onChangeText={setLinkQuery}
                placeholder="Search payee, note…"
                placeholderTextColor={colors.muted}
                autoFocus
                autoCorrect={false}
              />
              <FlatList
                data={candidates}
                keyExtractor={(t) => t.id}
                style={{ maxHeight: 280 }}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="none"
                ListEmptyComponent={
                  <Text style={styles.linkEmpty}>{linkQuery.trim().length < 2 ? 'Type at least 2 characters to search.' : 'No matching transactions.'}</Text>
                }
                renderItem={({ item }) => (
                  <Pressable style={({ pressed }) => [styles.catOption, pressed && { opacity: 0.6 }]} onPress={() => createLink(item)} disabled={addLink.isPending}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.catOptionText} numberOfLines={1}>{item.payee || '(no payee)'}</Text>
                      <Text style={styles.catOptionGroup}>{fmtDay(item.date)} · {item.account}</Text>
                    </View>
                    <Text style={[styles.catOptionText, { color: item.amount < 0 ? colors.text : colors.green }]}>{fmtPos(Math.abs(item.amount))}</Text>
                  </Pressable>
                )}
              />
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
      </Modal>

      <Modal visible={renaming} animationType="slide" transparent onRequestClose={() => setRenaming(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
          <Pressable style={styles.modalBg} onPress={() => setRenaming(false)}>
            <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]} onPress={() => {}}>
              <Text style={styles.sheetTitle}>Rename transaction</Text>
              <TextInput
                style={styles.searchInput}
                value={renameText}
                onChangeText={setRenameText}
                placeholder="Merchant name"
                placeholderTextColor={colors.muted}
                autoFocus
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={doRename}
              />
              <Pressable style={styles.renameSave} onPress={doRename} disabled={setPayee.isPending}>
                <Text style={styles.renameSaveText}>{setPayee.isPending ? 'Saving…' : 'Save'}</Text>
              </Pressable>
              <Text style={styles.tagHint}>The original bank description is kept for matching future charges.</Text>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={dating} animationType="slide" transparent onRequestClose={() => setDating(false)}>
        <Pressable style={styles.modalBg} onPress={() => setDating(false)}>
          <Pressable style={[styles.sheet, styles.calendarSheet, { paddingBottom: insets.bottom + 16 }]} onPress={() => {}}>
            <View style={styles.calendarSheetHeader}>
              <View>
                <Text style={styles.sheetTitle}>Transaction date</Text>
                <Text style={styles.calendarSub}>{selectedDay ? fmtDay(selectedDay) : 'Pick a date'}</Text>
              </View>
              <Pressable onPress={() => setDating(false)} hitSlop={10}>
                <Text style={styles.calendarDone}>Done</Text>
              </Pressable>
            </View>

            <View style={styles.calendarNav}>
              <Pressable
                onPress={() =>
                  monthPicking
                    ? setCalendarMonth(new Date(calendarMonth.getFullYear() - 1, calendarMonth.getMonth(), 1))
                    : changeCalendarMonth(-1)
                }
                style={({ pressed }) => [styles.calendarNavBtn, pressed && { opacity: 0.6 }]}
              >
                <Text style={styles.calendarNavText}>‹</Text>
              </Pressable>
              <Pressable
                onPress={() => { setMonthPicking(!monthPicking); haptics.tap(); }}
                style={({ pressed }) => [styles.calendarTitleBtn, pressed && { opacity: 0.7 }]}
              >
                <Text style={styles.calendarTitle}>{monthPicking ? calendarMonth.getFullYear() : monthLabel(selectedMonthKey)}</Text>
                <Text style={styles.calendarTitleCaret}>{monthPicking ? '⌃' : '⌄'}</Text>
              </Pressable>
              <Pressable
                onPress={() =>
                  monthPicking
                    ? setCalendarMonth(new Date(calendarMonth.getFullYear() + 1, calendarMonth.getMonth(), 1))
                    : changeCalendarMonth(1)
                }
                style={({ pressed }) => [styles.calendarNavBtn, pressed && { opacity: 0.6 }]}
              >
                <Text style={styles.calendarNavText}>›</Text>
              </Pressable>
            </View>

            {monthPicking ? (
              <View style={styles.monthGrid}>
                {MONTH_NAMES.map((name, idx) => {
                  const active = idx === calendarMonth.getMonth();
                  return (
                    <Pressable
                      key={name}
                      onPress={() => { setCalendarMonth(new Date(calendarMonth.getFullYear(), idx, 1)); setMonthPicking(false); haptics.tap(); }}
                      style={({ pressed }) => [styles.monthCell, active && styles.monthCellActive, pressed && { opacity: 0.7 }]}
                    >
                      <Text style={[styles.monthCellText, active && styles.monthCellTextActive]}>{name}</Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : (
              <>
                <View style={styles.weekRow}>
                  {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, idx) => (
                    <Text key={`${d}-${idx}`} style={styles.weekText}>{d}</Text>
                  ))}
                </View>
                <View style={styles.dayGrid}>
                  {calendarDays.map((day, idx) => {
                    const active = !!day && day === selectedDay;
                    const today = !!day && day === todayKey;
                    return (
                      <Pressable
                        key={day ?? `blank-${idx}`}
                        disabled={!day || setDate.isPending}
                        onPress={() => day && doSetDate(day)}
                        style={({ pressed }) => [
                          styles.dayCell,
                          active && styles.dayCellActive,
                          today && !active && styles.dayCellToday,
                          pressed && { opacity: 0.7 },
                        ]}
                      >
                        <Text style={[styles.dayText, active && styles.dayTextActive, !day && { opacity: 0 }]}>{day ? Number(day.slice(8)) : '0'}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            )}

            <View style={styles.suggestRow}>
              <Pressable onPress={() => pickShortcutDate(todayKey)} style={({ pressed }) => [styles.suggestChip, pressed && { opacity: 0.6 }]}>
                <Text style={styles.suggestText}>Today</Text>
              </Pressable>
              <Pressable onPress={() => pickShortcutDate(lastMonthLastDay())} style={({ pressed }) => [styles.suggestChip, pressed && { opacity: 0.6 }]}>
                <Text style={styles.suggestText}>End of last month</Text>
              </Pressable>
            </View>
            {setDate.isPending ? <Text style={styles.calendarSaving}>Saving…</Text> : null}
            <Text style={styles.tagHint}>
              {income
                ? 'A refund dated in the month you made the purchase subtracts from that month’s spending instead of this one.'
                : 'Changing the date moves this transaction into a different month.'}
            </Text>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={!!viewerId} animationType="fade" transparent onRequestClose={() => setViewerId(null)}>
        <Pressable style={styles.viewerBg} onPress={() => setViewerId(null)}>
          <Pressable style={[styles.viewerClose, { top: insets.top + 12 }]} onPress={() => setViewerId(null)}>
            <Text style={styles.viewerCloseText}>Done</Text>
          </Pressable>
          {viewerId ? (
            <Image source={receiptSource(viewerId)} style={styles.viewerImg} contentFit="contain" transition={150} cachePolicy="memory-disk" />
          ) : null}
          {(() => {
            const r = receiptList.find((x) => x.id === viewerId);
            if (!r) return null;
            return (
              <View style={[styles.viewerMeta, { paddingBottom: insets.bottom + 12 }]}>
                {r.amount != null || r.date ? (
                  <Text style={styles.viewerMetaText}>
                    {r.amount != null ? fmtPos(r.amount) : ''}{r.amount != null && r.date ? ' · ' : ''}{r.date || ''}
                  </Text>
                ) : null}
                <Pressable onPress={() => removeReceipt(r.id)} disabled={delReceipt.isPending} style={({ pressed }) => [styles.viewerDelete, pressed && { opacity: 0.7 }]}>
                  <Text style={styles.viewerDeleteText}>{delReceipt.isPending ? 'Deleting…' : 'Delete receipt'}</Text>
                </Pressable>
              </View>
            );
          })()}
        </Pressable>
      </Modal>

    </ScrollView>
  );
}

function MenuGroup({ children, testID }: { children: React.ReactNode; testID?: string }) {
  return <View testID={testID} style={styles.menuGroup}>{children}</View>;
}

function MenuActionRow({
  icon,
  label,
  right,
  onPress,
  disabled,
  last,
}: {
  icon: SymbolViewProps['name'];
  label: string;
  right?: string;
  onPress?: () => void;
  disabled?: boolean;
  last?: boolean;
}) {
  return (
    <Pressable onPress={onPress} disabled={disabled || !onPress} style={({ pressed }) => [styles.menuRow, last && styles.menuRowLast, disabled && { opacity: 0.55 }, pressed && { opacity: 0.65 }]}>
      <SymbolView name={icon} tintColor={colors.text} size={23} resizeMode="scaleAspectFit" style={styles.menuRowIcon} />
      <Text style={styles.menuRowLabel} numberOfLines={1}>{label}</Text>
      {right ? <Text style={styles.menuRowRight} numberOfLines={1}>{right}</Text> : null}
      {onPress && !disabled ? <SymbolView name="chevron.right" tintColor={colors.muted} size={12} resizeMode="scaleAspectFit" /> : null}
    </Pressable>
  );
}

function MenuSwitchRow({
  icon,
  label,
  value,
  disabled,
  onValueChange,
}: {
  icon: SymbolViewProps['name'];
  label: string;
  value: boolean;
  disabled?: boolean;
  onValueChange: () => void;
}) {
  return (
    <View style={styles.menuRow}>
      <SymbolView name={icon} tintColor={colors.text} size={23} resizeMode="scaleAspectFit" style={styles.menuRowIcon} />
      <Text style={styles.menuRowLabel}>{label}</Text>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        trackColor={{ false: 'rgba(255,255,255,0.18)', true: colors.accent }}
        thumbColor="#fff"
        ios_backgroundColor="rgba(255,255,255,0.18)"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  menuHero: { alignItems: 'center', paddingHorizontal: 20, paddingBottom: 28, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.08)' },
  menuTopBar: { width: '100%', minHeight: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  topSide: { width: 72, minHeight: 36, alignItems: 'center', justifyContent: 'center' },
  closeBtn: { alignItems: 'flex-end' },
  topDateBtn: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16 },
  topDate: { color: colors.text, fontSize: 17, fontWeight: '800' },
  menuBody: { paddingHorizontal: 18, paddingTop: 18 },
  pendingBubble: { backgroundColor: '#fff', borderRadius: 999, paddingHorizontal: 18, paddingVertical: 9, marginBottom: 28 },
  pendingBubbleText: { color: '#201f24', fontSize: 15, fontWeight: '800' },
  amount: { fontSize: 38, fontWeight: '800', letterSpacing: -1.5 },
  payee: { color: colors.text, fontSize: 19, fontWeight: '800', marginTop: 8, textAlign: 'center' },
  statementBlock: { alignItems: 'center', marginTop: 22 },
  statementLabel: { color: colors.text, opacity: 0.9, fontSize: 13, fontWeight: '800' },
  statementText: { color: colors.text, opacity: 0.85, fontSize: 13, fontWeight: '700', letterSpacing: 0.4, marginTop: 3 },
  categoryPill: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.85)', borderRadius: 999, paddingHorizontal: 17, paddingVertical: 11, marginTop: 28 },
  categoryPillText: { color: colors.text, fontSize: 15, fontWeight: '800' },
  menuGroup: { backgroundColor: '#242426', borderRadius: 22, overflow: 'hidden', marginBottom: 18 },
  menuRow: { minHeight: 65, flexDirection: 'row', alignItems: 'center', gap: 18, paddingHorizontal: 24, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)' },
  menuRowLast: { borderBottomWidth: 0 },
  menuRowIcon: { width: 26 },
  menuRowLabel: { color: colors.text, fontSize: 18, fontWeight: '600', flex: 1 },
  menuRowRight: { color: colors.text, opacity: 0.9, fontSize: 16, fontWeight: '800', maxWidth: 150 },
  historyBtn: { marginTop: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderColor: colors.text, borderRadius: 999, paddingVertical: 14 },
  historyText: { color: colors.text, fontSize: 17, fontWeight: '800' },
  historyArrow: { color: colors.text, fontSize: 18, fontWeight: '700' },
  metaBlock: { marginTop: 20, gap: 18 },
  metaItem: { gap: 2 },
  metaLabel: { color: colors.text, fontSize: 13, fontWeight: '900' },
  metaValue: { color: colors.text, opacity: 0.9, fontSize: 13, fontWeight: '700', textDecorationLine: 'underline' },
  metaMuted: { color: colors.text, opacity: 0.62, fontSize: 13, fontWeight: '600' },
  deleteBtn: { marginTop: 12, borderWidth: 1, borderColor: colors.red, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  deleteText: { color: colors.red, fontSize: 15, fontWeight: '700' },
  receiptRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, paddingVertical: 4 },
  thumb: { width: 76, height: 76, borderRadius: 10, overflow: 'hidden', backgroundColor: colors.surface2, justifyContent: 'flex-end' },
  thumbImg: { width: '100%', height: '100%' },
  thumbAmt: { position: 'absolute', bottom: 0, left: 0, right: 0, color: '#fff', fontSize: 11, fontWeight: '800', paddingHorizontal: 4, paddingVertical: 2, backgroundColor: 'rgba(0,0,0,0.45)' },
  thumbAdd: { width: 76, height: 76, borderRadius: 10, borderWidth: 1, borderColor: colors.accent, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', gap: 2 },
  thumbAddPlus: { color: colors.accentLight, fontSize: 24, fontWeight: '700', lineHeight: 26 },
  thumbAddText: { color: colors.accentLight, fontSize: 11, fontWeight: '700' },
  receiptHint: { color: colors.muted, fontSize: 12, marginTop: 8, lineHeight: 16 },
  viewerBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.94)', justifyContent: 'center' },
  viewerImg: { flex: 1, width: '100%' },
  viewerClose: { position: 'absolute', top: 60, right: 20, zIndex: 2, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)' },
  viewerCloseText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  viewerMeta: { position: 'absolute', bottom: 0, left: 0, right: 0, alignItems: 'center', gap: 10, paddingTop: 12 },
  viewerMetaText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  viewerDelete: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.red },
  viewerDeleteText: { color: colors.red, fontSize: 14, fontWeight: '700' },
  subBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(124,110,247,0.1)', borderColor: colors.accent, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 8 },
  subText: { color: colors.accentLight, fontSize: 13, fontWeight: '600', flex: 1 },
  subArrow: { color: colors.accentLight, fontSize: 20, fontWeight: '700' },
  list: { paddingVertical: 2 },
  sectionTitle: { marginTop: 22 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  linkMain: { flex: 1, minWidth: 0 },
  linkPayee: { color: colors.text, fontSize: 14, fontWeight: '600' },
  linkSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  unlink: { color: colors.red, fontSize: 12, fontWeight: '600' },
  linkEmpty: { color: colors.muted, fontSize: 13, paddingVertical: 8 },
  linkBtn: { paddingVertical: 10, alignItems: 'center' },
  linkBtnText: { color: colors.accentLight, fontSize: 14, fontWeight: '700' },
  searchInput: { backgroundColor: colors.surface2, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: colors.text, fontSize: 15, marginBottom: 12 },
  notes: { color: colors.text, fontSize: 15, minHeight: 44, textAlignVertical: 'top' },
  headerSave: { color: colors.accentLight, fontSize: 16, fontWeight: '700' },
  tagAddRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tagHash: { color: colors.muted, fontSize: 16, fontWeight: '700' },
  tagInput: { flex: 1, color: colors.text, fontSize: 15, paddingVertical: 4 },
  tagAddBtn: { backgroundColor: colors.surface2, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  tagAddBtnText: { color: colors.accentLight, fontSize: 13, fontWeight: '700' },
  suggestRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  suggestChip: { backgroundColor: colors.surface2, borderRadius: 11, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 9, paddingVertical: 4 },
  suggestText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  tagHint: { color: colors.muted, fontSize: 11, marginTop: 10 },
  tripLabel: { color: colors.muted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 14, marginBottom: 6 },
  tripChip: { backgroundColor: 'rgba(124,110,247,0.12)', borderRadius: 11, borderWidth: 1, borderColor: colors.accent, paddingHorizontal: 10, paddingVertical: 5 },
  tripChipText: { color: colors.accentLight, fontSize: 12, fontWeight: '700', maxWidth: 160 },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16 },
  sheetTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: 12 },
  calendarSheet: { paddingTop: 14 },
  calendarSheetHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 },
  calendarSub: { color: colors.muted, fontSize: 12, marginTop: -6 },
  calendarDone: { color: colors.accentLight, fontSize: 15, fontWeight: '800' },
  calendarNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  calendarNavBtn: { width: 42, height: 38, borderRadius: 12, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
  calendarNavText: { color: colors.text, fontSize: 25, fontWeight: '700', lineHeight: 27 },
  calendarTitleBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12 },
  calendarTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  calendarTitleCaret: { color: colors.muted, fontSize: 12, fontWeight: '800', marginTop: 2 },
  weekRow: { flexDirection: 'row', marginBottom: 6 },
  weekText: { flex: 1, textAlign: 'center', color: colors.muted, fontSize: 11, fontWeight: '800' },
  dayGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  dayCell: { width: '14.2857%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 999 },
  dayCellActive: { backgroundColor: colors.accent },
  dayCellToday: { borderWidth: 1, borderColor: colors.accent },
  dayText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  dayTextActive: { color: '#fff' },
  monthGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4, marginBottom: 8 },
  monthCell: { width: '31.5%', borderRadius: 14, backgroundColor: colors.surface2, paddingVertical: 14, alignItems: 'center' },
  monthCellActive: { backgroundColor: colors.accent },
  monthCellText: { color: colors.text, fontSize: 14, fontWeight: '800' },
  monthCellTextActive: { color: '#fff' },
  calendarSaving: { color: colors.muted, fontSize: 12, fontWeight: '700', textAlign: 'center', marginTop: 10 },
  renameSave: { backgroundColor: colors.accent, borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 2 },
  renameSaveText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  catOption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  catOptionText: { color: colors.text, fontSize: 15 },
  catOptionGroup: { color: colors.muted, fontSize: 12 },
  legInfoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  legInfoName: { color: colors.text, fontSize: 14, fontWeight: '600' },
  legInfoSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  legInfoAmt: { color: colors.text, fontSize: 14, fontWeight: '700' },
});

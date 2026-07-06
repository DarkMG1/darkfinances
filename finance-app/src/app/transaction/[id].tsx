import React, { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
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
import { Avatar, Card, CardTitle, TagChips } from '@/components/ui';
import { haptics } from '@/lib/haptics';
import { CapturedReceipt, pickReceiptFromLibrary, saveReceiptLocal, scanReceiptFromCamera } from '@/lib/receipts';
import { cadenceLabel, colors, dueLabel, fmtDay, fmtMoney, fmtPos, NoteTag, parseNoteTags, tagKind, toTagToken } from '@/theme/colors';

const norm = (s: string) =>
  (s || '').toLowerCase().replace(/[#*]?\d{3,}/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

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
  const [dateText, setDateText] = useState(p.date || '');
  const [category, setCategoryName] = useState(p.category || '');
  const [categoryId, setCategoryId] = useState(p.categoryId || '');
  const parsedNotes = useMemo(() => parseNoteTags(p.notes), [p.notes]);
  const [noteText, setNoteText] = useState(parsedNotes.text);
  const [tags, setTags] = useState<NoteTag[]>(parsedNotes.tags);
  const [tagInput, setTagInput] = useState('');
  // Baselines move forward on save so the Save button only shows real changes.
  const [baseText, setBaseText] = useState(parsedNotes.text);
  const [baseRaws, setBaseRaws] = useState<string[]>(parsedNotes.tags.map((t) => t.raw));
  // Tags present at load may drive attribution — confirm before removing.
  const originalRaws = useRef(new Set(parsedNotes.tags.map((t) => t.raw.toLowerCase()))).current;
  const allTags = useTags();
  const [picking, setPicking] = useState(false);
  const [linking, setLinking] = useState(false);
  const [linkQuery, setLinkQuery] = useState('');

  const links = useReimbLinks(p.id);
  const addLink = useAddReimbLink();
  const delLink = useDeleteReimbLink();
  const search = useSearch(linkQuery);

  const thisRef: ReimbTxnRef = { id: p.id, date: p.date || null, payee: p.payee || '', amount };
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
    setCategory.mutate({ id: p.id, categoryId: cid, isLeg, parentId: p.parentId || null, accountId: p.accountId, date: p.date });
    setCategoryName(categoryName);
    setCategoryId(cid);
    setPicking(false);
  };

  // --- Rules, mark-as-recurring (power features). Splitting lives on its own screen.
  const canSplit = !isLeg && !isSplit && !!p.accountId && !!p.date && amount !== 0;
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
              { id: p.id, accountId: p.accountId, date: p.date },
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
      { id: p.id, categoryId: reimbCat.id, isLeg, parentId: p.parentId || null, accountId: p.accountId, date: p.date },
      { onSuccess: () => haptics.success(), onError: (e) => Alert.alert('Could not move', e.error || 'Please try again.') }
    );
    setCategoryName(reimbCat.name);
    setCategoryId(reimbCat.id);
  };

  // Change date — dating a refund back to the purchase month makes it net that
  // month's spending. Split legs follow their parent, so only non-legs qualify.
  const canEditDate = !isLeg && !!p.id;
  const lastMonthLastDay = () => { const now = new Date(); const d = new Date(now.getFullYear(), now.getMonth(), 0); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const openDate = () => { setDateText(p.date || ''); setDating(true); haptics.tap(); };
  const doSetDate = () => {
    const next = (dateText || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) { Alert.alert('Invalid date', 'Use the format YYYY-MM-DD, e.g. 2026-06-30.'); return; }
    if (next === p.date) { setDating(false); return; }
    setDate.mutate(
      { id: p.id, date: next, isLeg },
      {
        onSuccess: () => { haptics.success(); setDating(false); router.back(); },
        onError: (e) => Alert.alert('Could not change date', e.error || 'Please try again.'),
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
      { id: p.id, payee: next, isLeg, parentId: p.parentId || null, accountId: p.accountId, date: p.date },
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
      { id: p.id, notes: recombineNotes(), isLeg, parentId: p.parentId || null, accountId: p.accountId, date: p.date },
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

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <Stack.Screen
        options={{
          title: payeeName || 'Transaction',
          headerRight: dirty
            ? () => (
                <Pressable onPress={save} disabled={setNotes.isPending} hitSlop={8}>
                  <Text style={styles.headerSave}>{setNotes.isPending ? 'Saving…' : 'Save'}</Text>
                </Pressable>
              )
            : undefined,
        }}
      />

      <View style={styles.hero}>
        <Avatar label={payeeName} category={p.category || undefined} size={56} style={{ marginBottom: 10 }} />
        <Text style={[styles.amount, { color: income ? colors.green : colors.text }]}>{income ? '+' : ''}{fmtMoney(amount)}</Text>
        {canRename ? (
          <Pressable onPress={openRename} hitSlop={8} style={({ pressed }) => pressed && { opacity: 0.6 }}>
            <Text style={styles.payee}>{payeeName || 'Add name'}</Text>
          </Pressable>
        ) : (
          <Text style={styles.payee}>{payeeName || '—'}</Text>
        )}
        <Text style={styles.date}>{fmtDay(p.date)} · {p.account}</Text>
        {pending ? (
          <View style={styles.pendingBanner}>
            <Text style={styles.pendingBannerText}>PENDING · not yet posted</Text>
          </View>
        ) : null}
      </View>

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
      ) : (
        <>
          <CardTitle style={styles.sectionTitle}>Category</CardTitle>
          <Pressable onPress={() => { haptics.tap(); setPicking(true); }} style={({ pressed }) => pressed && { opacity: 0.7 }}>
            <Card style={styles.pickRow}>
              <Text style={[styles.pickValue, !category && { color: colors.muted }]}>{category || 'Uncategorized — tap to set'}</Text>
              <Text style={styles.pickArrow}>›</Text>
            </Card>
          </Pressable>
        </>
      )}

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

      {canSplit || canMoveReimb || (!isLeg && categoryId) || canMarkRecurring || canEditDate ? (
        <>
          <CardTitle style={styles.sectionTitle}>More</CardTitle>
          <Card style={styles.list}>
            {canSplit ? (
              <ActionRow label="Split transaction" sub="Divide across multiple categories" onPress={goSplit} />
            ) : null}
            {canMoveReimb ? (
              <ActionRow
                label="Move to Reimbursements"
                sub="Someone else pays this — won't count as your spending"
                onPress={moveToReimb}
                disabled={setCategory.isPending}
              />
            ) : null}
            {!isLeg && categoryId ? (
              <ActionRow
                label={`Auto-categorize “${p.payee}”`}
                sub={saveRule.isPending ? 'Saving…' : `Always set to ${category}`}
                onPress={applyRuleForPayee}
                disabled={saveRule.isPending}
              />
            ) : null}
            {canMarkRecurring ? (
              <ActionRow
                label="Mark as recurring"
                sub={markRec.isPending ? 'Saving…' : 'Track this in Subscriptions'}
                onPress={doMarkRecurring}
                disabled={markRec.isPending}
              />
            ) : null}
            {canEditDate ? (
              <ActionRow
                label="Change date"
                sub={income ? 'Move a refund back to the month you bought it' : 'Move this to a different day or month'}
                onPress={openDate}
                disabled={setDate.isPending}
                last
              />
            ) : null}
          </Card>
        </>
      ) : null}

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

      {canHistory ? (
        <Pressable onPress={goHistory} style={({ pressed }) => [styles.historyBtn, pressed && { opacity: 0.7 }]}>
          <Text style={styles.historyText}>See History{histCount != null ? ` (${histCount})` : ''}</Text>
          <Text style={styles.historyArrow}>›</Text>
        </Pressable>
      ) : null}

      {canDelete ? (
        <Pressable
          onPress={doDelete}
          disabled={del.isPending}
          style={({ pressed }) => [styles.deleteBtn, del.isPending && { opacity: 0.5 }, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.deleteText}>{del.isPending ? 'Deleting…' : 'Delete transaction'}</Text>
        </Pressable>
      ) : null}

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
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
          <Pressable style={styles.modalBg} onPress={() => setDating(false)}>
            <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]} onPress={() => {}}>
              <Text style={styles.sheetTitle}>Change date</Text>
              <TextInput
                style={styles.searchInput}
                value={dateText}
                onChangeText={setDateText}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.muted}
                autoFocus
                autoCorrect={false}
                keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'}
                returnKeyType="done"
                onSubmitEditing={doSetDate}
              />
              <View style={styles.suggestRow}>
                <Pressable onPress={() => setDateText(lastMonthLastDay())} style={({ pressed }) => [styles.suggestChip, pressed && { opacity: 0.6 }]}>
                  <Text style={styles.suggestText}>End of last month</Text>
                </Pressable>
              </View>
              <Pressable style={styles.renameSave} onPress={doSetDate} disabled={setDate.isPending}>
                <Text style={styles.renameSaveText}>{setDate.isPending ? 'Saving…' : 'Save date'}</Text>
              </Pressable>
              <Text style={styles.tagHint}>
                {income
                  ? 'A refund dated in the month you made the purchase subtracts from that month’s spending instead of this one.'
                  : 'Changing the date moves this transaction into a different month.'}
              </Text>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
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

function ActionRow({ label, sub, onPress, disabled, last }: { label: string; sub?: string; onPress: () => void; disabled?: boolean; last?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={({ pressed }) => [styles.actionRow, last && { borderBottomWidth: 0 }, pressed && { opacity: 0.6 }]}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.actionLabel} numberOfLines={1}>{label}</Text>
        {sub ? <Text style={styles.actionSub} numberOfLines={1}>{sub}</Text> : null}
      </View>
      <Text style={styles.pickArrow}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  hero: { alignItems: 'center', marginVertical: 12 },
  amount: { fontSize: 38, fontWeight: '800', letterSpacing: -1.5 },
  payee: { color: colors.text, fontSize: 16, fontWeight: '600', marginTop: 8 },
  date: { color: colors.muted, fontSize: 13, marginTop: 4 },
  pendingBanner: { marginTop: 10, backgroundColor: 'rgba(234,179,8,0.15)', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  pendingBannerText: { color: colors.yellow, fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  historyBtn: { marginTop: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: 12, paddingVertical: 13 },
  historyText: { color: colors.accentLight, fontSize: 15, fontWeight: '700' },
  historyArrow: { color: colors.accentLight, fontSize: 18, fontWeight: '700' },
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
  pickRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pickValue: { color: colors.text, fontSize: 15, flex: 1 },
  pickArrow: { color: colors.muted, fontSize: 20, fontWeight: '700' },
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
  renameSave: { backgroundColor: colors.accent, borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 2 },
  renameSaveText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  catOption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  catOptionText: { color: colors.text, fontSize: 15 },
  catOptionGroup: { color: colors.muted, fontSize: 12 },
  actionRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  actionLabel: { color: colors.text, fontSize: 15, fontWeight: '600' },
  actionSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  legInfoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  legInfoName: { color: colors.text, fontSize: 14, fontWeight: '600' },
  legInfoSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  legInfoAmt: { color: colors.text, fontSize: 14, fontWeight: '700' },
});

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { SymbolView, SymbolViewProps } from 'expo-symbols';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
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
import { ReimbLinkEndpoint, ReimbTxnRef, Transaction } from '@/api/generated/types';
import { Card, CardTitle, TagChips } from '@/components/ui';
import { MutationFormBanner, MutationFieldError, MutationLiveRegion } from '@/components/mutation-form';
import { useMutationScreen } from '@/hooks/useMutationScreen';
import { haptics } from '@/lib/haptics';
import { formatAllocationDollars, parseStrictAllocationDollars } from '@/lib/allocation-parse';
import { CapturedReceipt, pickReceiptFromLibrary, scanReceiptFromCamera } from '@/lib/receipts';
import { categoryIcon } from '@/theme/categoryIcons';
import { cadenceLabel, colors, dueLabel, fmtDay, fmtMoney, fmtPos, monthLabel, NoteTag, parseNoteTags, tagKind, toTagToken } from '@/theme/colors';
import { useFinanceToday } from '@/lib/date-only';

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
    id: string; payee?: string; amount?: string; date?: string; account?: string; accountId?: string;
    category?: string; categoryId?: string; notes?: string; isLeg?: string; parentId?: string; cleared?: string;
    isSplit?: string; splitCount?: string; imported?: string;
  }>();
  const router = useRouter();
  const navigation = useNavigation();
  const financeTodayValue = useFinanceToday();
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

  const detail = useTransaction(p.id, p.accountId, p.date);
  const canonical = detail.data;
  const txnId = canonical?.id ?? p.id;
  const accountId = canonical?.accountId ?? p.accountId ?? '';
  const accountName = canonical?.account ?? p.account ?? '';
  const parentId = canonical?.parentId ?? p.parentId ?? null;
  const canonicalPayee = canonical?.payee ?? p.payee ?? '';
  const isLeg = canonical?.isLeg ?? p.isLeg === '1';
  const isSplit = canonical?.isSplit ?? p.isSplit === '1';
  const amount = canonical?.amount ?? (Number(p.amount) || 0);
  const income = amount > 0;
  const pending = canonical ? !canonical.cleared : p.cleared === '0'; // cleared:false = bank hasn't posted it yet
  // Only user-created rows are deletable — bank-imported ones aren't (Rocket Money parity).
  const canDelete = !isLeg && (canonical ? !canonical.imported : p.imported !== '1');

  const splitLegs = detail.data?.legs ?? [];
  const splitCount = Number(p.splitCount) || splitLegs.length;
  const goSplit = () => {
    haptics.tap();
    router.push({ pathname: '/split/[id]', params: { id: txnId, accountId, date: currentDate } });
  };

  const [payeeName, setPayeeNameLocal] = useState(canonicalPayee);
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState(canonicalPayee);
  const [dating, setDating] = useState(false);
  const [txnDate, setTxnDate] = useState(canonical?.date ?? p.date ?? '');
  const [dateText, setDateText] = useState(p.date ?? '');
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = parseYmd(p.date || financeTodayValue);
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [monthPicking, setMonthPicking] = useState(false);
  const [category, setCategoryName] = useState(canonical?.category ?? p.category ?? '');
  const [categoryId, setCategoryId] = useState(canonical?.categoryId ?? p.categoryId ?? '');
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
  const originalRawsRef = useRef(new Set(parsedNotes.tags.map((t) => t.raw.toLowerCase())));
  const originalRaws = originalRawsRef.current;
  const allTags = useTags();
  const [picking, setPicking] = useState(false);
  const [linking, setLinking] = useState(false);
  const [linkQuery, setLinkQuery] = useState('');
  const [linkTarget, setLinkTarget] = useState<Transaction | null>(null);
  const [allocationText, setAllocationText] = useState('');
  const allocationInputRef = useRef<TextInput>(null);
  const loadedIdentity = useRef<string | null>(null);
  useEffect(() => {
    if (!canonical) return;
    const identity = `${canonical.id}|${canonical.date}`;
    if (loadedIdentity.current === identity) return;
    loadedIdentity.current = identity;
    const nextParsed = parseNoteTags(canonical.notes);
    setPayeeNameLocal(canonical.payee);
    setRenameText(canonical.payee);
    setTxnDate(canonical.date);
    setDateText(canonical.date);
    const parsedDate = parseYmd(canonical.date);
    setCalendarMonth(new Date(parsedDate.getFullYear(), parsedDate.getMonth(), 1));
    setCategoryName(canonical.category || '');
    setCategoryId(canonical.categoryId || '');
    setNoteText(nextParsed.text);
    setTags(nextParsed.tags);
    setShowTags(nextParsed.tags.length > 0);
    setShowNotes(!!nextParsed.text);
    setBaseText(nextParsed.text);
    setBaseRaws(nextParsed.tags.map((tag) => tag.raw));
    originalRawsRef.current = new Set(nextParsed.tags.map((tag) => tag.raw.toLowerCase()));
  }, [canonical]);
  const currentDate = txnDate || canonical?.date || p.date || financeTodayValue;

  const links = useReimbLinks(txnId);
  const counterpartyLinks = useReimbLinks(linkTarget?.id);
  const receipts = useReceipts(txnId);
  const addReceipt = useAddReceipt();
  const delReceipt = useDeleteReceipt();
  const addLink = useAddReimbLink();
  const delLink = useDeleteReimbLink();
  const screen = useMutationScreen({
    onRefetchStale: async () => {
      const result = await detail.refetch();
      return result.isError !== true;
    },
  });
  const linkAction = screen.bind({ key: 'link', mutation: addLink, mutationLabel: 'Link reimbursement', fieldOrder: ['allocationCents'] });
  const unlinkAction = screen.bind({ key: 'unlink', mutation: delLink, mutationLabel: 'Unlink reimbursement' });
  const receiptAction = screen.bind({ key: 'receipt', mutation: addReceipt, mutationLabel: 'Upload receipt' });
  const deleteReceiptAction = screen.bind({ key: 'deleteReceipt', mutation: delReceipt, mutationLabel: 'Delete receipt' });
  const deleteTxnAction = screen.bind({ key: 'deleteTxn', mutation: del, mutationLabel: 'Delete transaction' });
  const categoryAction = screen.bind({ key: 'category', mutation: setCategory, mutationLabel: 'Change category' });
  const saveRuleAction = screen.bind({ key: 'saveRule', mutation: saveRule, mutationLabel: 'Save rule' });
  const markRecAction = screen.bind({ key: 'markRec', mutation: markRec, mutationLabel: 'Mark recurring' });
  const dateAction = screen.bind({ key: 'date', mutation: setDate, mutationLabel: 'Change date', fieldOrder: ['date'] });
  const payeeAction = screen.bind({ key: 'payee', mutation: setPayee, mutationLabel: 'Rename payee' });
  const notesAction = screen.bind({ key: 'notes', mutation: setNotes, mutationLabel: 'Save notes', fieldOrder: ['notes'] });
  const modalLocked = screen.isLocked;
  const allowBackRef = useRef(false);
  const requestModalClose = (close: () => void) => {
    if (modalLocked) return;
    close();
  };
  const search = useSearch(linkQuery);

  const thisRef: ReimbTxnRef = {
    id: txnId,
    date: currentDate || null,
    payee: payeeName,
    amount,
    accountId,
    account: accountName,
    imported: canonical?.imported,
  };
  // For an inflow we show the expenses it repays; for an expense, the inflows that repaid it.
  const linked = (income ? links.data?.asInflow : links.data?.asExpense) ?? [];
  const capacity = links.data?.capacity;
  const thisCapacityReady = !links.isLoading
    && capacity != null
    && capacity.completeness !== 'ambiguous';
  const otherCapacityReady = !linkTarget
    || (!counterpartyLinks.isLoading
      && counterpartyLinks.data?.capacity != null
      && counterpartyLinks.data.capacity.completeness !== 'ambiguous');
  const suggestedAllocationCents = useMemo(() => {
    if (!linkTarget || !thisCapacityReady || !otherCapacityReady) return null;
    const thisRemaining = capacity!.remainingTrustedCents;
    const otherRemaining = counterpartyLinks.data!.capacity!.remainingTrustedCents;
    return Math.max(0, Math.min(thisRemaining, otherRemaining));
  }, [linkTarget, thisCapacityReady, otherCapacityReady, capacity, counterpartyLinks.data]);

  const openAllocationFor = (t: Transaction) => {
    setLinkTarget(t);
    setAllocationText('');
  };

  const submitLink = () => {
    if (!linkTarget || screen.isLocked) return;
    const cents = parseStrictAllocationDollars(allocationText);
    if (cents == null || cents <= 0) {
      screen.reportClientValidation('Enter a positive dollar amount with at most two decimal places (e.g. 20.00).', { allocationCents: 'Invalid allocation amount.' }, ['allocationCents']);
      return;
    }
    if (suggestedAllocationCents == null) {
      screen.reportClientValidation('Link capacity is still loading or needs legacy review. Refresh and try again.');
      return;
    }
    if (cents > suggestedAllocationCents) {
      screen.reportClientValidation(`This link can allocate at most ${fmtPos(suggestedAllocationCents / 100)} based on remaining capacity on both sides.`, { allocationCents: 'Allocation exceeds remaining capacity.' }, ['allocationCents']);
      return;
    }
    const ref: ReimbTxnRef = {
      id: linkTarget.id,
      date: linkTarget.date,
      payee: linkTarget.payee,
      amount: linkTarget.amount,
      accountId: linkTarget.accountId,
      account: linkTarget.account,
      imported: linkTarget.imported,
    };
    const vars = income
      ? { inflow: thisRef, expense: ref, allocationCents: cents }
      : { inflow: ref, expense: thisRef, allocationCents: cents };
    haptics.tap();
    linkAction.run(vars, {
      onSuccess: () => {
        setLinking(false);
        setLinkTarget(null);
        setLinkQuery('');
        setAllocationText('');
        links.refetch();
        counterpartyLinks.refetch();
      },
    });
  };
  // The picker lists the opposite sign: an inflow links to expenses, vice versa.
  const candidates = (search.data?.transactions ?? []).filter((t) => t.id !== txnId && (income ? t.amount < 0 : t.amount > 0));

  const openTxn = (t: ReimbTxnRef) =>
    router.push({
      pathname: '/transaction/[id]',
      params: { id: t.id, date: t.date ?? '', accountId: t.accountId ?? '' },
    });

  const createLink = (t: Transaction) => openAllocationFor(t);
  const removeLink = (other: ReimbLinkEndpoint) => {
    if (screen.isLocked) return;
    haptics.tap();
    unlinkAction.run(
      income
        ? { inflowId: txnId, expenseId: other.id, expectedVersion: other.linkVersion }
        : { inflowId: other.id, expenseId: txnId, expectedVersion: other.linkVersion },
      { onSuccess: () => { links.refetch(); counterpartyLinks.refetch(); } },
    );
  };

  const sub = (recurring.data?.items ?? []).find((i) => norm(payeeName) === i.key || norm(payeeName).includes(i.key));

  const followReplacement = (result?: { id?: string }) => {
    if (!result?.id || result.id === txnId) return;
    router.replace({
      pathname: '/transaction/[id]',
      params: { id: result.id, accountId, date: currentDate },
    });
  };

  const pickCategory = (cid: string, categoryName: string) => {
    const previous = { category, categoryId };
    setCategoryName(categoryName);
    setCategoryId(cid);
    setPicking(false);
    categoryAction.run(
      { id: txnId, categoryId: cid, isLeg, parentId, accountId, date: currentDate },
      {
        onSuccess: (data) => followReplacement(data as { id?: string } | undefined),
        rollback: () => {
          setCategoryName(previous.category);
          setCategoryId(previous.categoryId);
        },
      },
    );
  };

  // --- Rules, mark-as-recurring (power features). Splitting lives on its own screen.
  const canSplit = !isLeg && !isSplit && !!accountId && !!currentDate && amount !== 0;
  const canMarkRecurring = !isLeg && amount < 0 && !!payeeName && !sub;

  const applyRuleForPayee = () => {
    if (!categoryId) return;
    saveRuleAction.run(
      { match: payeeName, categoryId, categoryName: category },
      {
        onSuccess: (r) => {
          const result = r as { applied?: number } | undefined;
          Alert.alert(
            'Rule saved',
            `"${payeeName}" will always be categorized as ${category}.` +
              (result?.applied ? `\n\nApplied to ${result.applied} past transaction${result.applied === 1 ? '' : 's'}.` : ''),
          );
        },
      },
    );
  };
  const doMarkRecurring = () => {
    markRecAction.run(
      { payee: payeeName },
      {
        onSuccess: () => Alert.alert('Marked as recurring', `"${payeeName}" will appear in Subscriptions once it has at least two charges.`),
      },
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
            deleteTxnAction.run(
              { id: txnId, accountId, date: currentDate },
              { onSuccess: () => { router.back(); } },
            ),
        },
      ]
    );
  };
  // Receipts — scan/attach, view full-screen, delete. OCR runs on-device (Vision).
  const receiptSource = useReceiptImageSource();
  const receiptList = receipts.data?.receipts ?? [];
  const [scanning, setScanning] = useState(false);
  const [viewerId, setViewerId] = useState<string | null>(null);

  const uploadCapture = (cap: CapturedReceipt | null) => {
    if (!cap) { setScanning(false); return; }
    if (!cap.base64) { setScanning(false); screen.reportClientValidation('Could not read image. Please try again.'); return; }
    receiptAction.run(
      { txnId, accountId, transactionDate: currentDate, imageBase64: cap.base64, mime: cap.mime, ocrText: cap.ocrText, ocrLines: cap.ocrLines, amount: cap.amount, date: cap.date, source: cap.source ?? 'camera' },
      { onSettled: () => setScanning(false) },
    );
  };
  const reviewCapture = (cap: CapturedReceipt | null) => {
    setScanning(false);
    if (!cap) return;
    const details = [
      cap.amount != null ? `Detected total: ${fmtPos(cap.amount)}` : 'No total detected',
      cap.date ? `Detected date: ${fmtDay(cap.date)}` : 'No date detected',
    ].join('\n');
    Alert.alert('Receipt ready', `${details}\n\nUpload this resized receipt to your server?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Upload', onPress: () => { setScanning(true); uploadCapture(cap); } },
    ]);
  };
  const startScan = () => {
    if (scanning) return;
    haptics.tap();
    Alert.alert('Add receipt', 'The image is resized and text is read on-device, then the receipt is uploaded to your server.', [
      { text: 'Take Photo', onPress: async () => { setScanning(true); try { reviewCapture(await scanReceiptFromCamera()); } catch (e: any) { setScanning(false); Alert.alert('Camera unavailable', e?.message || 'Please try again.'); } } },
      { text: 'Choose from Library', onPress: async () => { setScanning(true); try { reviewCapture(await pickReceiptFromLibrary()); } catch (e: any) { setScanning(false); Alert.alert('Library unavailable', e?.message || 'Please try again.'); } } },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };
  const removeReceipt = (id: string) => {
    if (modalLocked || deleteReceiptAction.isPending) return;
    Alert.alert('Delete receipt', 'Remove this receipt image?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => deleteReceiptAction.run({ id }, { onSuccess: () => { setViewerId(null); } }),
      },
    ]);
  };
  const receiptDeleting = deleteReceiptAction.isPending;
  const closeReceiptViewer = () => {
    if (receiptDeleting) return;
    setViewerId(null);
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
    const previous = { category, categoryId };
    setCategoryName(reimbCat.name);
    setCategoryId(reimbCat.id);
    categoryAction.run(
      { id: txnId, categoryId: reimbCat.id, isLeg, parentId, accountId, date: currentDate },
      {
        onSuccess: (data) => followReplacement(data as { id?: string } | undefined),
        rollback: () => {
          setCategoryName(previous.category);
          setCategoryId(previous.categoryId);
        },
      },
    );
  };

  // Change date — dating a refund back to the purchase month makes it net that
  // month's spending. Split legs follow their parent, so only non-legs qualify.
  const canEditDate = !isLeg && !!txnId;
  const lastMonthLastDay = () => {
    const today = financeTodayValue;
    const [y, m] = today.split('-').map(Number);
    return ymd(new Date(y, m - 1, 0));
  };
  const openDate = () => {
    const current = currentDate || financeTodayValue;
    const d = parseYmd(current);
    setDateText(current);
    setCalendarMonth(new Date(d.getFullYear(), d.getMonth(), 1));
    setMonthPicking(false);
    setDating(true);
    haptics.tap();
  };
  const doSetDate = (picked?: string) => {
    const next = (picked || dateText || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) {
      screen.reportClientValidation('Use the format YYYY-MM-DD, e.g. 2026-06-30.', { date: 'Invalid date format.' }, ['date']);
      return;
    }
    if (next === currentDate) { setDating(false); return; }
    dateAction.run(
      { id: txnId, date: next, isLeg },
      {
        onSuccess: () => {
          setTxnDate(next);
          setDateText(next);
          setDating(false);
          router.replace({ pathname: '/transaction/[id]', params: { id: txnId, accountId, date: next } });
        },
        rollback: () => { setDateText(currentDate || financeTodayValue); },
      },
    );
  };

  const canRename = !isLeg;
  const openRename = () => { setRenameText(payeeName); setRenaming(true); haptics.tap(); };
  const doRename = () => {
    const next = renameText.trim();
    setRenaming(false);
    if (next === payeeName) return;
    const prev = payeeName;
    setPayeeNameLocal(next);
    payeeAction.run(
      { id: txnId, payee: next, isLeg, parentId, accountId, date: currentDate },
      {
        onSuccess: (data) => followReplacement(data as { id?: string } | undefined),
        rollback: () => { setPayeeNameLocal(prev); },
      },
    );
  };

  // Notes text + #tags both serialize into the single notes field, so save them
  // together. Recombine human text with the (now editable) tag set.
  const rawsOf = (list: NoteTag[]) => list.map((t) => t.raw);
  const sameRaws = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const dirty = noteText.trim() !== baseText || !sameRaws(rawsOf(tags), baseRaws);
  const recombineNotes = () => [noteText.trim(), ...tags.map((t) => t.raw)].join(' ').replace(/\s{2,}/g, ' ').trim();
  const save = () =>
    notesAction.run(
      { id: txnId, notes: recombineNotes(), isLeg, parentId, accountId, date: currentDate },
      {
        onSuccess: (result) => {
          setBaseText(noteText.trim());
          setBaseRaws(rawsOf(tags));
          followReplacement(result as { id?: string } | undefined);
        },
      },
    );
  const notesFieldError = screen.outcome?.fieldErrors?.notes as string | undefined;
  const allocationFieldError = screen.activeKey === 'link'
    ? (screen.outcome?.fieldErrors?.allocationCents as string | undefined)
    : undefined;

  const requestLeave = (leave: () => void) => {
    if (modalLocked) return;
    if (!dirty) {
      leave();
      return;
    }
    Alert.alert(
      'Discard unsaved changes?',
      'Your note and tag edits will be lost.',
      [
        { text: 'Keep editing', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => {
            allowBackRef.current = true;
            leave();
          },
        },
      ],
    );
  };

  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (e) => {
      if (allowBackRef.current) {
        allowBackRef.current = false;
        return;
      }
      if (modalLocked) {
        e.preventDefault();
        return;
      }
      if (!dirty) return;
      e.preventDefault();
      Alert.alert(
        'Discard unsaved changes?',
        'Your note and tag edits will be lost.',
        [
          { text: 'Keep editing', style: 'cancel' },
          {
            text: 'Discard',
            style: 'destructive',
            onPress: () => {
              allowBackRef.current = true;
              navigation.dispatch(e.data.action);
            },
          },
        ],
      );
    });
    return unsub;
  }, [baseRaws, baseText, dirty, modalLocked, navigation]);

  useEffect(() => {
    if (screen.activeKey !== 'link' || screen.outcome?.firstField !== 'allocationCents') return;
    const frame = requestAnimationFrame(() => allocationInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [screen.activeKey, screen.outcome]);

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
  const todayKey = financeTodayValue;
  const calendarDays = useMemo(() => {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const firstWeekday = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells: (string | null)[] = Array(firstWeekday).fill(null);
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
  const amountColor = income ? colors.green : colors.text;

  if (!canonical) {
    const message = !p.date
      ? 'This transaction link is missing its date.'
      : detail.isError
        ? detail.error?.error || 'Could not load the latest transaction.'
        : 'Loading transaction…';
    return (
      <View testID="transaction-detail-screen" style={styles.loadBox}>
        <Stack.Screen options={{ headerShown: false }} />
        {!detail.isError && p.date ? <ActivityIndicator color={colors.accentLight} /> : null}
        <Text style={styles.loadText}>{message}</Text>
        {detail.isError ? (
          <Pressable style={styles.retryButton} onPress={() => detail.refetch()}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

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

      <MutationLiveRegion message={screen.announce} />
      <MutationFormBanner
        outcome={screen.outcome}
        onRetry={screen.retry}
        onRefetch={() => { void screen.refetchStale(); detail.refetch(); links.refetch(); receipts.refetch(); }}
      />

      <View style={[styles.menuHero, { paddingTop: insets.top + 14 }]}>
        <View style={styles.menuTopBar}>
          <Pressable onPress={save} disabled={!dirty || notesAction.isPending || modalLocked} hitSlop={8} style={styles.topSide}>
            {dirty ? <Text style={styles.headerSave}>{notesAction.isPending ? 'Saving…' : 'Save'}</Text> : null}
          </Pressable>
          {canEditDate ? (
            <Pressable testID="transaction-date-button" onPress={openDate} hitSlop={8} style={({ pressed }) => [styles.topDateBtn, pressed && { opacity: 0.65 }]}>
              <Text style={styles.topDate}>{fmtMenuDay(currentDate)}</Text>
              <SymbolView name="chevron.down" tintColor={colors.text} size={11} resizeMode="scaleAspectFit" />
            </Pressable>
          ) : (
            <Text style={styles.topDate}>{fmtMenuDay(currentDate)}</Text>
          )}
          <Pressable onPress={() => requestLeave(() => router.back())} disabled={modalLocked} hitSlop={10} style={({ pressed }) => [styles.topSide, styles.closeBtn, pressed && { opacity: 0.65 }, modalLocked && { opacity: 0.35 }]}>
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
        <Text style={[styles.amount, { color: amountColor }]}>{income ? '+' : ''}{fmtMoney(amount)}</Text>
        {payeeName ? (
          <View style={styles.statementBlock}>
            <Text style={styles.statementLabel}>Statement Description</Text>
            <Text style={styles.statementText}>{payeeName.toUpperCase()}</Text>
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
              {sub.status === 'active' ? ` · next ${dueLabel(sub.nextRenewal, financeTodayValue)}` : ''}
            </Text>
            <Text style={styles.subArrow}>›</Text>
          </View>
        </Pressable>
      ) : null}

      <MenuGroup testID="transaction-action-menu">
        {canRename ? <MenuActionRow testID="transaction-rename-row" icon="pencil" label="Rename" onPress={openRename} /> : null}
        <MenuSwitchRow
          testID="transaction-recurring-switch-row"
          icon="arrow.clockwise.circle"
          label="Is Recurring?"
          value={!!sub}
          disabled={!!sub || !canMarkRecurring || markRecAction.isPending || modalLocked}
          onValueChange={() => {
            if (sub) router.push(`/recurring/${encodeURIComponent(sub.key)}`);
            else if (canMarkRecurring) doMarkRecurring();
          }}
        />
        {canMoveReimb ? (
          <MenuActionRow
            testID="transaction-move-reimbursement-row"
            icon="person.2.fill"
            label="Move to Reimbursements"
            right={categoryAction.isPending ? 'Moving…' : 'Not personal spend'}
            onPress={moveToReimb}
            disabled={categoryAction.isPending || modalLocked}
            last
          />
        ) : (
          <MenuActionRow testID="transaction-personal-spend-row" icon="nosign" label={income ? 'Deposit' : 'Personal spend'} right="Included" disabled last />
        )}
      </MenuGroup>

      <MenuGroup testID="transaction-secondary-menu">
        <MenuActionRow
          testID="transaction-tags-row"
          icon="tag"
          label={tags.length ? `Tags (${tags.length})` : 'Add Tags'}
          onPress={() => { setShowTags(!showTags); haptics.tap(); }}
        />
        <MenuActionRow
          testID="transaction-notes-row"
          icon="note.text"
          label={noteText.trim() ? 'Edit Note' : 'Add Note'}
          onPress={() => { setShowNotes(!showNotes); haptics.tap(); }}
        />
        {!isLeg && categoryId ? (
          <MenuActionRow
            testID="transaction-create-rule-row"
            icon="bolt.circle"
            label="Create Rule"
            right={saveRuleAction.isPending ? 'Saving…' : category}
            onPress={applyRuleForPayee}
            disabled={saveRuleAction.isPending || modalLocked}
          />
        ) : null}
        {canSplit ? (
          <MenuActionRow testID="transaction-split-row" icon="arrow.triangle.branch" label="Split" onPress={goSplit} />
        ) : null}
        <MenuActionRow testID="transaction-receipt-row" icon="doc.viewfinder" label={receiptList.length ? `Receipts (${receiptList.length})` : 'Add Receipt'} onPress={startScan} disabled={scanning} last />
      </MenuGroup>

      <CardTitle style={styles.sectionTitle}>{income ? 'Repayment for' : 'Repaid by'}</CardTitle>
      <Card style={styles.list}>
        {links.isLoading ? (
          <Text style={styles.linkEmpty} testID="transaction-link-capacity">Loading link capacity…</Text>
        ) : capacity ? (
          <Text style={styles.linkEmpty} testID="transaction-link-capacity">
            {capacity.completeness === 'ambiguous'
              ? 'Legacy links on this transaction need review before new allocations.'
              : `Remaining link capacity: ${fmtPos(capacity.remainingTrustedCents / 100)}`}
          </Text>
        ) : null}
        {linked.length ? (
          linked.map((t) => (
            <View key={t.id} testID={`transaction-linked-row-${t.id}`} style={styles.linkRow}>
              <Pressable testID={`transaction-linked-open-${t.id}`} style={({ pressed }) => [styles.linkMain, pressed && { opacity: 0.6 }]} onPress={() => openTxn(t)}>
                <Text style={styles.linkPayee} numberOfLines={1}>{t.payee || '(no payee)'}</Text>
                <Text style={styles.linkSub}>
                  {t.date ? fmtDay(t.date) : ''}
                  {t.allocationAmbiguous
                    ? ' · allocation needs review'
                    : t.allocatedCents != null
                      ? ` · linked ${fmtPos(t.allocatedCents / 100)}`
                      : ''}
                </Text>
              </Pressable>
              <Pressable testID={`transaction-linked-unlink-${t.id}`} hitSlop={10} onPress={() => removeLink(t)} disabled={modalLocked || unlinkAction.isPending} style={({ pressed }) => pressed && { opacity: 0.5 }} accessibilityRole="button" accessibilityLabel={`Unlink ${t.payee || 'transaction'}`}>
                <Text style={styles.unlink}>Unlink</Text>
              </Pressable>
            </View>
          ))
        ) : (
          <Text style={styles.linkEmpty}>{income ? 'Not linked to any expense yet.' : 'No linked repayment yet.'}</Text>
        )}
        <Pressable testID="transaction-link-repayment-button" style={({ pressed }) => [styles.linkBtn, pressed && { opacity: 0.6 }]} onPress={() => { haptics.tap(); setLinking(true); }}>
          <Text style={styles.linkBtnText}>{income ? '+ Link to an expense' : '+ Link a repayment'}</Text>
        </Pressable>
      </Card>

      {isSplit ? (
        <>
          <CardTitle style={styles.sectionTitle}>Split into {splitCount}</CardTitle>
          <Card style={styles.list}>
            {splitLegs.length ? (
              splitLegs.map((l, i) => (
                <View key={l.id ?? i} testID={`transaction-split-leg-${i}`} style={styles.legInfoRow}>
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
            <Pressable testID="transaction-edit-split-button" style={({ pressed }) => [styles.linkBtn, pressed && { opacity: 0.6 }]} onPress={goSplit}>
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
            testID="transaction-tag-input"
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
            <Pressable testID="transaction-tag-add-button" onPress={() => addTag(tagInput)} style={({ pressed }) => [styles.tagAddBtn, pressed && { opacity: 0.7 }]}>
              <Text style={styles.tagAddBtnText}>Add</Text>
            </Pressable>
          ) : null}
        </View>
        {tagSuggestions.length ? (
          <View style={styles.suggestRow}>
            {tagSuggestions.map((s) => (
              <Pressable testID={`transaction-tag-suggestion-${s.token}`} key={s.raw} onPress={() => addTag(s.raw)} style={({ pressed }) => [styles.suggestChip, pressed && { opacity: 0.6 }]}>
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
                <Pressable testID={`transaction-event-chip-${e.slug}`} key={e.slug} onPress={() => addTag(`ev-${e.slug}`)} style={({ pressed }) => [styles.tripChip, pressed && { opacity: 0.6 }]}>
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
          testID="transaction-notes-input"
          style={[styles.notes, notesFieldError && { borderWidth: 1, borderColor: '#ff6b6b' }]}
          value={noteText}
          onChangeText={setNoteText}
          placeholder="Add a note…"
          placeholderTextColor={colors.muted}
          multiline
          accessibilityLabel="Transaction notes"
          accessibilityHint={notesFieldError ? `Error: ${notesFieldError}` : undefined}
        />
        <MutationFieldError error={notesFieldError} testID="transaction-notes-error" />
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
            <Pressable testID={`transaction-receipt-${r.id}`} key={r.id} onPress={() => { haptics.tap(); setViewerId(r.id); }} style={({ pressed }) => [styles.thumb, pressed && { opacity: 0.7 }]}>
              <Image source={receiptSource(r.id)} style={styles.thumbImg} contentFit="cover" transition={120} cachePolicy="memory-disk" />
              {r.amount != null ? <Text style={styles.thumbAmt}>{fmtPos(r.amount)}</Text> : null}
            </Pressable>
          ))}
          <Pressable testID="transaction-receipt-scan-button" onPress={startScan} disabled={scanning} style={({ pressed }) => [styles.thumbAdd, pressed && { opacity: 0.7 }, scanning && { opacity: 0.5 }]}>
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
        <Pressable testID="transaction-history-button" onPress={goHistory} style={({ pressed }) => [styles.historyBtn, pressed && { opacity: 0.7 }]}>
          <Text style={styles.historyText}>See History{histCount != null ? ` (${histCount})` : ''}</Text>
          <Text style={styles.historyArrow}>›</Text>
        </Pressable>
      ) : null}

      <View style={styles.metaBlock}>
        {accountName ? (
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>Account</Text>
            <Text style={styles.metaValue}>{accountName}</Text>
          </View>
        ) : null}
        <View style={styles.metaItem}>
          <Text style={styles.metaLabel}>Ledger Date</Text>
          <Text style={styles.metaMuted}>{currentDate || 'Unknown'}</Text>
        </View>
      </View>

      {canDelete ? (
        <Pressable
          testID="transaction-delete-button"
          onPress={doDelete}
          disabled={deleteTxnAction.isPending || modalLocked}
          style={({ pressed }) => [styles.deleteBtn, (deleteTxnAction.isPending || modalLocked) && { opacity: 0.5 }, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.deleteText}>{deleteTxnAction.isPending ? 'Deleting…' : 'Delete transaction'}</Text>
        </Pressable>
      ) : null}

      </View>

      <Modal visible={picking} animationType="slide" transparent onRequestClose={() => requestModalClose(() => setPicking(false))}>
        <Pressable style={styles.modalBg} onPress={() => requestModalClose(() => setPicking(false))} disabled={modalLocked}>
          <View testID="transaction-category-sheet" style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.sheetTitle}>Set category</Text>
            <FlatList
              data={categories.data ?? []}
              keyExtractor={(c) => c.id}
              style={{ maxHeight: 400 }}
              renderItem={({ item }) => (
                <Pressable testID={`transaction-category-option-${item.id}`} style={({ pressed }) => [styles.catOption, pressed && { opacity: 0.6 }]} onPress={() => pickCategory(item.id, item.name)}>
                  <Text style={styles.catOptionText}>{item.name}</Text>
                  <Text style={styles.catOptionGroup}>{item.group}</Text>
                </Pressable>
              )}
            />
          </View>
        </Pressable>
      </Modal>

      <Modal visible={linking} animationType="slide" transparent onRequestClose={() => requestModalClose(() => { setLinking(false); setLinkTarget(null); })}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
          <Pressable style={styles.modalBg} onPress={() => requestModalClose(() => { setLinking(false); setLinkTarget(null); })} disabled={modalLocked}>
            <Pressable testID="transaction-link-sheet" style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]} onPress={() => {}}>
              {linkTarget ? (
                <>
                  <Text style={styles.sheetTitle}>How much of this link?</Text>
                  <Text style={styles.linkEmpty} testID="transaction-link-capacity-hint">
                    {!thisCapacityReady || !otherCapacityReady
                      ? (links.isLoading || counterpartyLinks.isLoading
                        ? 'Loading authoritative capacity for both transactions…'
                        : 'Capacity unavailable until legacy links are reviewed.')
                      : suggestedAllocationCents != null && suggestedAllocationCents > 0
                        ? `Suggested max ${fmtPos(suggestedAllocationCents / 100)} from remaining capacity on both sides.`
                        : 'No trusted remaining capacity on both sides.'}
                  </Text>
                  <TextInput
                    testID="transaction-link-allocation-input"
                    ref={allocationInputRef}
                    style={[styles.searchInput, allocationFieldError && { borderWidth: 1, borderColor: '#ff6b6b' }]}
                    value={allocationText}
                    onChangeText={setAllocationText}
                    placeholder={suggestedAllocationCents != null && suggestedAllocationCents > 0
                      ? formatAllocationDollars(suggestedAllocationCents)
                      : 'Amount in dollars'}
                    placeholderTextColor={colors.muted}
                    keyboardType="decimal-pad"
                    autoFocus
                    accessibilityLabel="Reimbursement link allocation amount in dollars"
                    accessibilityHint={allocationFieldError ? `Error: ${allocationFieldError}` : 'Enter a positive amount with at most two decimal places'}
                  />
                  <MutationFieldError error={allocationFieldError} testID="transaction-link-allocation-error" />
                  <Pressable testID="transaction-link-confirm-button" style={styles.renameSave} onPress={submitLink} disabled={linkAction.isPending || suggestedAllocationCents == null || modalLocked} accessibilityRole="button" accessibilityLabel="Confirm reimbursement link">
                    <Text style={styles.renameSaveText}>{linkAction.isPending ? 'Linking…' : 'Link'}</Text>
                  </Pressable>
                  <Pressable testID="transaction-link-back-button" style={styles.linkBtn} onPress={() => setLinkTarget(null)} disabled={linkAction.isPending || modalLocked}>
                    <Text style={[styles.linkBtnText, (linkAction.isPending || modalLocked) && { opacity: 0.35 }]}>Back to search</Text>
                  </Pressable>
                </>
              ) : (
                <>
              <Text style={styles.sheetTitle}>{income ? 'Pick the expense this repays' : 'Pick the repayment'}</Text>
              <TextInput
                testID="transaction-link-search-input"
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
                  <Pressable testID={`transaction-link-option-${item.id}`} style={({ pressed }) => [styles.catOption, pressed && { opacity: 0.6 }]} onPress={() => createLink(item)} disabled={linkAction.isPending || modalLocked}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.catOptionText} numberOfLines={1}>{item.payee || '(no payee)'}</Text>
                      <Text style={styles.catOptionGroup}>{fmtDay(item.date)} · {item.account}</Text>
                    </View>
                    <Text style={[styles.catOptionText, { color: item.amount < 0 ? colors.text : colors.green }]}>{fmtPos(Math.abs(item.amount))}</Text>
                  </Pressable>
                )}
              />
                </>
              )}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
      </Modal>

      <Modal visible={renaming} animationType="slide" transparent onRequestClose={() => requestModalClose(() => setRenaming(false))}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
          <Pressable style={styles.modalBg} onPress={() => requestModalClose(() => setRenaming(false))} disabled={modalLocked}>
            <Pressable testID="transaction-rename-sheet" style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]} onPress={() => {}}>
              <Text style={styles.sheetTitle}>Rename transaction</Text>
              <TextInput
                testID="transaction-rename-input"
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
              <Pressable testID="transaction-rename-save-button" style={styles.renameSave} onPress={doRename} disabled={payeeAction.isPending || modalLocked}>
                <Text style={styles.renameSaveText}>{payeeAction.isPending ? 'Saving…' : 'Save'}</Text>
              </Pressable>
              <Text style={styles.tagHint}>The original bank description is kept for matching future charges.</Text>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={dating} animationType="slide" transparent onRequestClose={() => requestModalClose(() => setDating(false))}>
        <Pressable style={styles.modalBg} onPress={() => requestModalClose(() => setDating(false))} disabled={modalLocked}>
          <Pressable testID="transaction-date-sheet" style={[styles.sheet, styles.calendarSheet, { paddingBottom: insets.bottom + 16 }]} onPress={() => {}}>
            <View style={styles.calendarSheetHeader}>
              <View>
                <Text style={styles.sheetTitle}>Transaction date</Text>
                <Text style={styles.calendarSub}>{selectedDay ? fmtDay(selectedDay) : 'Pick a date'}</Text>
              </View>
              <Pressable testID="transaction-date-done-button" onPress={() => requestModalClose(() => setDating(false))} hitSlop={10} disabled={modalLocked}>
                <Text style={styles.calendarDone}>Done</Text>
              </Pressable>
            </View>

            <View style={styles.calendarNav}>
              <Pressable
                testID="transaction-date-prev-button"
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
                testID="transaction-date-title-button"
                onPress={() => { setMonthPicking(!monthPicking); haptics.tap(); }}
                style={({ pressed }) => [styles.calendarTitleBtn, pressed && { opacity: 0.7 }]}
              >
                <Text style={styles.calendarTitle}>{monthPicking ? calendarMonth.getFullYear() : monthLabel(selectedMonthKey)}</Text>
                <Text style={styles.calendarTitleCaret}>{monthPicking ? '⌃' : '⌄'}</Text>
              </Pressable>
              <Pressable
                testID="transaction-date-next-button"
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
                      testID={`transaction-date-month-${idx}${active ? '-selected' : ''}`}
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
                        testID={day ? `transaction-date-day-${Number(day.slice(8))}${active ? '-selected' : ''}` : undefined}
                        key={day ?? `blank-${idx}`}
                        disabled={!day || dateAction.isPending || modalLocked}
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
              <Pressable testID="transaction-date-today-button" onPress={() => pickShortcutDate(todayKey)} style={({ pressed }) => [styles.suggestChip, pressed && { opacity: 0.6 }]}>
                <Text style={styles.suggestText}>Today</Text>
              </Pressable>
              <Pressable testID="transaction-date-last-month-button" onPress={() => pickShortcutDate(lastMonthLastDay())} style={({ pressed }) => [styles.suggestChip, pressed && { opacity: 0.6 }]}>
                <Text style={styles.suggestText}>End of last month</Text>
              </Pressable>
            </View>
            {dateAction.isPending ? <Text style={styles.calendarSaving}>Saving…</Text> : null}
            <Text style={styles.tagHint}>
              {income
                ? 'A refund dated in the month you made the purchase subtracts from that month’s spending instead of this one.'
                : 'Changing the date moves this transaction into a different month.'}
            </Text>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={!!viewerId} animationType="fade" transparent onRequestClose={closeReceiptViewer}>
        <Pressable style={styles.viewerBg} onPress={closeReceiptViewer}>
          <Pressable style={[styles.viewerClose, { top: insets.top + 12 }]} onPress={closeReceiptViewer} disabled={receiptDeleting}>
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
                <Pressable testID="transaction-receipt-delete-button" onPress={() => removeReceipt(r.id)} disabled={modalLocked || deleteReceiptAction.isPending} style={({ pressed }) => [styles.viewerDelete, pressed && { opacity: 0.7 }]}>
                  <Text style={styles.viewerDeleteText}>{deleteReceiptAction.isPending ? 'Deleting…' : 'Delete receipt'}</Text>
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
  testID,
  icon,
  label,
  right,
  onPress,
  disabled,
  last,
}: {
  testID?: string;
  icon: SymbolViewProps['name'];
  label: string;
  right?: string;
  onPress?: () => void;
  disabled?: boolean;
  last?: boolean;
}) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={right ? `${label}, ${right}` : label} onPress={onPress} disabled={disabled || !onPress} style={({ pressed }) => [styles.menuRow, last && styles.menuRowLast, disabled && { opacity: 0.55 }, pressed && { opacity: 0.65 }]}>
      <View style={styles.menuIconBubble}>
        <SymbolView name={icon} tintColor={colors.accentLight} size={15} resizeMode="scaleAspectFit" />
      </View>
      <Text style={styles.menuRowLabel} numberOfLines={1}>{label}</Text>
      {right ? <Text style={styles.menuRowRight} numberOfLines={1}>{right}</Text> : null}
      {onPress && !disabled ? <SymbolView name="chevron.right" tintColor={colors.muted} size={12} resizeMode="scaleAspectFit" /> : null}
    </Pressable>
  );
}

function MenuSwitchRow({
  testID,
  icon,
  label,
  value,
  disabled,
  onValueChange,
}: {
  testID?: string;
  icon: SymbolViewProps['name'];
  label: string;
  value: boolean;
  disabled?: boolean;
  onValueChange: () => void;
}) {
  return (
    <View testID={testID} style={styles.menuRow}>
      <View style={styles.menuIconBubble}>
        <SymbolView name={icon} tintColor={colors.accentLight} size={15} resizeMode="scaleAspectFit" />
      </View>
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
  loadBox: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 28 },
  loadText: { color: colors.muted, fontSize: 14, textAlign: 'center' },
  retryButton: { backgroundColor: colors.accent, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 10 },
  retryText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  menuHero: { alignItems: 'center', marginHorizontal: 16, marginTop: 8, paddingHorizontal: 16, paddingBottom: 18, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 18 },
  menuTopBar: { width: '100%', minHeight: 32, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  topSide: { width: 68, minHeight: 32, alignItems: 'center', justifyContent: 'center' },
  closeBtn: { alignItems: 'flex-end' },
  topDateBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border },
  topDate: { color: colors.text, fontSize: 14, fontWeight: '800' },
  menuBody: { paddingHorizontal: 16, paddingTop: 14 },
  pendingBubble: { backgroundColor: 'rgba(234,179,8,0.14)', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, marginBottom: 16 },
  pendingBubbleText: { color: colors.yellow, fontSize: 12, fontWeight: '800' },
  amount: { fontSize: 34, fontWeight: '800', letterSpacing: -1.2 },
  payee: { color: colors.text, fontSize: 17, fontWeight: '800', marginTop: 6, textAlign: 'center' },
  statementBlock: { alignItems: 'center', marginTop: 14, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 12, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border },
  statementLabel: { color: colors.muted, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 },
  statementText: { color: colors.text, fontSize: 12, fontWeight: '700', letterSpacing: 0.35, marginTop: 3 },
  categoryPill: { flexDirection: 'row', alignItems: 'center', gap: 7, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 8, marginTop: 16 },
  categoryPillText: { color: colors.text, fontSize: 13, fontWeight: '800' },
  menuGroup: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 14, overflow: 'hidden', marginBottom: 12 },
  menuRow: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  menuRowLast: { borderBottomWidth: 0 },
  menuIconBubble: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(124,110,247,0.14)' },
  menuRowLabel: { color: colors.text, fontSize: 14, fontWeight: '600', flex: 1 },
  menuRowRight: { color: colors.muted, fontSize: 12, fontWeight: '800', maxWidth: 140 },
  historyBtn: { marginTop: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: 14, paddingVertical: 11 },
  historyText: { color: colors.accentLight, fontSize: 14, fontWeight: '800' },
  historyArrow: { color: colors.accentLight, fontSize: 16, fontWeight: '700' },
  metaBlock: { marginTop: 18, gap: 14 },
  metaItem: { gap: 2 },
  metaLabel: { color: colors.text, fontSize: 13, fontWeight: '900' },
  metaValue: { color: colors.text, opacity: 0.9, fontSize: 13, fontWeight: '700', textDecorationLine: 'underline' },
  metaMuted: { color: colors.text, opacity: 0.62, fontSize: 13, fontWeight: '600' },
  deleteBtn: { marginTop: 12, borderWidth: 1, borderColor: 'rgba(239,68,68,0.45)', backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: 12, paddingVertical: 11, alignItems: 'center' },
  deleteText: { color: colors.red, fontSize: 14, fontWeight: '700' },
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
  subBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(124,110,247,0.1)', borderColor: colors.border, borderWidth: 1, borderRadius: 12, padding: 10, marginBottom: 10 },
  subText: { color: colors.accentLight, fontSize: 13, fontWeight: '600', flex: 1 },
  subArrow: { color: colors.accentLight, fontSize: 20, fontWeight: '700' },
  list: { paddingVertical: 2 },
  sectionTitle: { marginTop: 18, marginBottom: 10 },
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

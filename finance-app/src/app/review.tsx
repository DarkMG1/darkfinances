import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useRouter } from 'expo-router';
import { SymbolView, SymbolViewProps } from 'expo-symbols';
import { useReview, useSetReviewDisposition } from '@/api/hooks/finance.hooks';
import { ReviewTask, ReviewTransactionRef } from '@/api/generated/types';
import { PushScreen } from '@/components/screen';
import { QueryScreenBody } from '@/components/query-display';
import { MutationFormBanner, MutationLiveRegion } from '@/components/mutation-form';
import { useMutationAction } from '@/hooks/useMutationAction';
import { Avatar, Card, CardTitle, EmptyState, Pill } from '@/components/ui';
import { SkeletonList } from '@/components/skeleton';
import { haptics } from '@/lib/haptics';
import { heroMetricAccessibilityLabel } from '@/lib/metric-a11y.js';
import { colors, fmtDate, fmtPos, fmtSignedMoney, moneyColor } from '@/theme/colors';

const KIND_ICON: Record<ReviewTask['kind'], { symbol: SymbolViewProps['name']; color: string }> = {
  uncategorized: { symbol: 'tag.fill', color: colors.yellow },
  large_charge: { symbol: 'exclamationmark.triangle.fill', color: colors.red },
  missing_receipt: { symbol: 'doc.text.image.fill', color: colors.accentLight },
  pending: { symbol: 'clock.fill', color: colors.muted },
  repayment: { symbol: 'arrow.left.arrow.right.circle.fill', color: colors.green },
  price_change: { symbol: 'repeat', color: colors.accentLight },
  reconciliation: { symbol: 'checklist', color: colors.yellow },
  transfer_identity: { symbol: 'arrow.left.arrow.right.circle.fill', color: colors.yellow },
};

const kindLabel: Record<ReviewTask['kind'], string> = {
  uncategorized: 'Uncategorized',
  large_charge: 'Large charge',
  missing_receipt: 'Receipt',
  pending: 'Pending',
  repayment: 'Repayment',
  price_change: 'Price change',
  reconciliation: 'Month close',
  transfer_identity: 'Transfer identity',
};

const titleFor = (task: ReviewTask) => {
  if (task.transaction?.payee) return task.transaction.payee;
  return task.subtitle || task.title;
};

const subtitleFor = (task: ReviewTask) => {
  if (task.transaction) {
    const parts = [kindLabel[task.kind], task.transaction.account, task.transaction.category || null].filter(Boolean);
    return parts.join(' · ');
  }
  return task.subtitle;
};

const showBadge = (task: ReviewTask) => task.kind !== 'uncategorized';

function openTransaction(router: ReturnType<typeof useRouter>, t: ReviewTransactionRef) {
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
      imported: t.imported ? '1' : '',
    },
  });
}

export default function ReviewScreen() {
  const router = useRouter();
  const review = useReview();
  const setDisposition = useSetReviewDisposition();
  const acknowledgeAction = useMutationAction({
    mutation: setDisposition,
    mutationLabel: 'Acknowledge task',
    onRefetch: () => review.refetch(),
  });
  const tasksKnown = Array.isArray(review.data?.tasks);
  const tasks = review.data?.tasks ?? [];

  const openTask = (task: ReviewTask) => {
    if (acknowledgeAction.isLocked) return;
    haptics.tap();
    if (task.transaction) return openTransaction(router, task.transaction);
    if (task.action === 'open_reimbursement') return router.push('/reimbursement' as never);
    if (task.action === 'open_recurring' && task.key) return router.push({ pathname: '/recurring/[key]', params: { key: task.key } });
    if (task.action === 'open_reconcile') return router.push({ pathname: '/reconcile', params: { month: task.month || '' } });
    return undefined;
  };

  const markReviewed = (id: string) => {
    if (acknowledgeAction.isLocked) return;
    acknowledgeAction.run({ id, disposition: 'acknowledge' });
  };

  const renderActions = (task: ReviewTask) => (
    <View style={styles.actions}>
      <Pressable testID={`review-task-open-${task.id}`} style={[styles.actionBtn, { backgroundColor: colors.accent }, acknowledgeAction.isLocked && { opacity: 0.5 }]} disabled={acknowledgeAction.isLocked} onPress={() => openTask(task)}>
        <Text style={styles.actionText}>{task.action === 'categorize' ? 'Categorize' : 'Open'}</Text>
      </Pressable>
      <Pressable testID={`review-task-reviewed-${task.id}`} style={[styles.actionBtn, acknowledgeAction.isLocked && { opacity: 0.5 }]} disabled={acknowledgeAction.isLocked} onPress={() => markReviewed(task.id)}>
        <Text style={styles.actionText}>Acknowledge</Text>
      </Pressable>
    </View>
  );

  const renderTask = (task: ReviewTask) => {
    const icon = KIND_ICON[task.kind];
    const amount = task.transaction ? task.transaction.amount : task.amount;
    const title = titleFor(task);
    const subtitle = subtitleFor(task);
    const navLocked = acknowledgeAction.isLocked;
    const row = (
      <Pressable
        testID={`review-task-${task.id}`}
        onPress={() => openTask(task)}
        disabled={navLocked}
        style={({ pressed }) => [styles.row, pressed && !navLocked && { opacity: 0.65 }, navLocked && { opacity: 0.55 }]}
      >
        <Avatar label={task.transaction?.payee} size={38} />
        <View style={[styles.icon, { backgroundColor: icon.color + '22' }]}>
          <SymbolView name={icon.symbol} tintColor={icon.color} size={17} resizeMode="scaleAspectFit" />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.titleLine}>
            <Text style={styles.title} numberOfLines={1}>{title}</Text>
            {showBadge(task) ? <Pill text={kindLabel[task.kind]} kind={task.priority >= 80 ? 'open' : 'partial'} /> : null}
          </View>
          <Text style={styles.sub} numberOfLines={1}>{subtitle}{task.date ? ` · ${fmtDate(task.date)}` : ''}</Text>
        </View>
        <Text style={[styles.amount, { color: moneyColor(amount, task.transaction?.amount && task.transaction.amount > 0 ? 'goodWhenPositive' : 'neutral') }]}>
          {task.transaction ? fmtSignedMoney(task.transaction.amount) : fmtPos(task.amount)}
        </Text>
      </Pressable>
    );
    if (navLocked) return <View key={task.id}>{row}</View>;
    return (
      <Swipeable key={task.id} renderRightActions={() => renderActions(task)} overshootRight={false}>
        {row}
      </Swipeable>
    );
  };

  return (
    <PushScreen testID="review-screen" onRefresh={review.refetch}>
      <MutationLiveRegion message={acknowledgeAction.announce} />
      <MutationFormBanner outcome={acknowledgeAction.outcome} onRetry={acknowledgeAction.retry} onRefetch={() => review.refetch()} />
      <QueryScreenBody
        query={review}
        loading={<SkeletonList rows={6} />}
        empty={<EmptyState icon={tasksKnown ? 'checkmark.circle' : 'exclamationmark.triangle'}>{tasksKnown ? 'Nothing needs review right now' : 'Review details unavailable'}</EmptyState>}
        hasContent={tasks.length > 0}
        refetchBannerTestID="review-refetch-banner"
        renderContent={(reviewData) => {
          const reviewTasks = reviewData.tasks ?? [];
          const highPriority = reviewTasks.filter((t) => t.priority >= 80);
          const normalPriority = reviewTasks.filter((t) => t.priority < 80);
          return (
          <>
          <Card
            testID="review-hero"
            style={styles.hero}
            accessible
            accessibilityLabel={heroMetricAccessibilityLabel('Today review', String(reviewTasks.length), 'Prioritized from categorization, reimbursements, large charges, subscription changes, and reconciliation.')}
          >
            <Text style={styles.heroLabel} accessibilityElementsHidden importantForAccessibility="no">TODAY REVIEW</Text>
            <Text style={styles.heroValue} accessibilityElementsHidden importantForAccessibility="no">{reviewTasks.length}</Text>
            <Text style={styles.heroSub} accessibilityElementsHidden importantForAccessibility="no">Prioritized from categorization, reimbursements, large charges, subscription changes, and reconciliation.</Text>
          </Card>

          {highPriority.length ? (
            <>
              <CardTitle>Needs Attention</CardTitle>
              <Card style={styles.list}>{highPriority.map(renderTask)}</Card>
            </>
          ) : null}

          {normalPriority.length ? (
            <>
              <CardTitle style={{ marginTop: 16 }}>Later</CardTitle>
              <Card style={styles.list}>{normalPriority.map(renderTask)}</Card>
            </>
          ) : null}

          <Text style={styles.hint}>Swipe a row to open it or acknowledge it across devices. Editing the underlying transaction resolves matching tasks after refresh.</Text>
          </>
          );
        }}
      />
    </PushScreen>
  );
}

const styles = StyleSheet.create({
  hero: { marginBottom: 18 },
  heroLabel: { color: colors.muted, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  heroValue: { color: colors.text, fontSize: 42, fontWeight: '800', letterSpacing: -1.4, marginTop: 4 },
  heroSub: { color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 4 },
  list: { paddingVertical: 2 },
  row: { minHeight: 70, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  icon: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', marginLeft: -18, borderWidth: 1, borderColor: colors.surface },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: colors.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  sub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  amount: { color: colors.text, fontSize: 14, fontWeight: '700', marginLeft: 8 },
  actions: { flexDirection: 'row', alignItems: 'stretch' },
  actionBtn: { width: 88, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface2, borderLeftWidth: 1, borderLeftColor: colors.border },
  actionText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 12, paddingHorizontal: 2 },
});

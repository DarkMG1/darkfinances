'use strict';

const { locateExactTransactionIdInAccounts } = require('./repayment-transaction-locator');
const { categoryIdentityFingerprint, canonicalRulesFingerprint } = require('./bulk-operation-fingerprint');
const {
  assertMirrorStructuralAdmission,
  assertNoMirrorAmbiguity,
  bootstrapAccountResourceKey,
  bootstrapCategoryResourceKey,
  indexMirrorRowsBySourceId,
  keeperRowForSource,
  mirrorIdentityFingerprint,
  mirrorIntentFromItem,
  mirrorIntentMatches,
  myShareExpenseCents,
  resolutionIndex,
  snapshotBinding,
} = require('./splitwise-mirror');

const ACCOUNT_RANGE_START = '1900-01-01';
const ACCOUNT_RANGE_END = '9999-12-31';

function norm(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function payeeAlike(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  return short.length >= 3 && long.includes(short);
}

function d2(cents) {
  return Math.round(cents) / 100;
}

function daysOld(date, today) {
  const start = String(date).slice(0, 10);
  const end = String(today).slice(0, 10);
  const left = Date.parse(`${start}T12:00:00.000Z`);
  const right = Date.parse(`${end}T12:00:00.000Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
  return Math.max(0, Math.round((right - left) / 86400000));
}

function noteText(transaction) {
  return String(transaction.notes || '');
}

function hasNote(transaction) {
  return noteText(transaction).trim().length > 0;
}

function hasKeepNote(transaction) {
  return /(^|\s)#keep\b|\[keep\]/i.test(noteText(transaction));
}

function isDropOffHoldNote(transaction) {
  const notes = noteText(transaction);
  return /\b(auth|authorization|hold|pending)\b/i.test(notes)
    && /\b(drop|drops|dropped|fall|falls|fell|release|released|temporary)\b/i.test(notes);
}

function nextGlobalIndex(items, start = 0) {
  let index = start;
  return (item) => ({ ...item, globalIndex: index++ });
}

async function loadAccountRows(api, { includeClosed = false } = {}) {
  const accounts = (await api.getAccounts()).filter((account) => includeClosed || !account.closed);
  const rowsByAccount = {};
  for (const account of accounts) {
    rowsByAccount[String(account.id)] = await api.getTransactions(
      account.id,
      ACCOUNT_RANGE_START,
      ACCOUNT_RANGE_END,
    );
  }
  return { accounts, rowsByAccount };
}

function pushCategoryItem(items, assignIndex, {
  stageId,
  accountId,
  transaction,
  categoryId,
  accountOpenAtPlan = true,
}) {
  items.push(assignIndex({
    itemType: 'category_update',
    stageId,
    accountId: String(accountId),
    txnId: String(transaction.id),
    date: String(transaction.date),
    identityFingerprint: categoryIdentityFingerprint(transaction),
    accountOpenAtPlan,
    intent: { categoryId: String(categoryId) },
  }));
}

async function planRulesApply(api, {
  rules,
  merchantCatalog,
  catalogTypeMatch,
  resolveCatalogCategory,
  buildCatInfo,
  settleUpPayee,
  reimbCat,
  incomeGroup,
  moneyMovementGroup,
  today,
  addDays,
  months = 24,
}) {
  const start = addDays(today, -Math.round(30.44 * months));
  const { accounts, rowsByAccount } = await loadAccountRows(api);
  const payees = await api.getPayees();
  const payeeNames = Object.fromEntries(payees.map((payee) => [payee.id, payee.name || '']));
  const groups = await api.getCategoryGroups();
  const catInfo = buildCatInfo(groups);
  const typeCat = {};
  for (const type of Object.keys(catalogTypeMatch)) {
    typeCat[type] = resolveCatalogCategory(type, groups, catInfo);
  }

  const items = [];
  const assignIndex = nextGlobalIndex(items);
  const claimed = new Set();

  for (const rule of rules) {
    const needle = (rule.match || '').toLowerCase().trim();
    if (!needle || !rule.categoryId) continue;
    for (const account of accounts) {
      const txns = (rowsByAccount[String(account.id)] || [])
        .filter((txn) => txn.date >= start && txn.date <= today);
      for (const txn of txns) {
        if (txn.is_parent || txn.parent_id || txn.category || txn.transfer_id) continue;
        const name = (payeeNames[txn.payee] || txn.imported_payee || '').toLowerCase();
        if (!name.includes(needle)) continue;
        const id = String(txn.id);
        if (claimed.has(id)) continue;
        claimed.add(id);
        pushCategoryItem(items, assignIndex, {
          stageId: `rule:${rule.id}`,
          accountId: account.id,
          transaction: txn,
          categoryId: rule.categoryId,
          accountOpenAtPlan: !account.closed,
        });
      }
    }
  }

  for (const account of accounts) {
    const txns = (rowsByAccount[String(account.id)] || [])
      .filter((txn) => txn.date >= start && txn.date <= today);
    for (const txn of txns) {
      if (txn.is_parent || txn.parent_id || txn.category || txn.transfer_id) continue;
      const id = String(txn.id);
      if (claimed.has(id)) continue;
      const hay = `${payeeNames[txn.payee] || txn.imported_payee || ''} ${txn.notes || ''}`;
      for (const entry of merchantCatalog) {
        if (!entry.rx.test(hay)) continue;
        if (entry.type === 'income' ? !(txn.amount > 0) : !(txn.amount < 0)) break;
        const categoryId = typeCat[entry.type];
        if (!categoryId) break;
        claimed.add(id);
        pushCategoryItem(items, assignIndex, {
          stageId: 'catalog',
          accountId: account.id,
          transaction: txn,
          categoryId,
          accountOpenAtPlan: !account.closed,
        });
        break;
      }
    }
  }

  let reimbId = null;
  for (const group of groups) {
    for (const category of group.categories || []) {
      if (reimbCat.test(category.name || '')) reimbId = category.id;
    }
  }
  if (reimbId) {
    for (const account of accounts.filter((item) => !item.offbudget)) {
      const txns = rowsByAccount[String(account.id)] || [];
      for (const txn of txns) {
        if (txn.is_parent || txn.parent_id || !(txn.amount > 0)) continue;
        const meta = txn.category ? catInfo[txn.category] : null;
        if (!meta || meta.kind !== 'income') continue;
        const hay = `${payeeNames[txn.payee] || txn.imported_payee || ''} ${txn.notes || ''}`;
        if (!settleUpPayee.test(hay)) continue;
        const id = String(txn.id);
        if (claimed.has(id)) continue;
        claimed.add(id);
        pushCategoryItem(items, assignIndex, {
          stageId: 'settle-ups',
          accountId: account.id,
          transaction: txn,
          categoryId: reimbId,
          accountOpenAtPlan: !account.closed,
        });
      }
    }
  }

  return {
    stages: [
      { stageId: 'rules', itemIndexes: items.filter((item) => item.stageId.startsWith('rule:')).map((i) => i.globalIndex) },
      { stageId: 'catalog', itemIndexes: items.filter((item) => item.stageId === 'catalog').map((i) => i.globalIndex) },
      { stageId: 'settle-ups', itemIndexes: items.filter((item) => item.stageId === 'settle-ups').map((i) => i.globalIndex) },
    ],
    items,
    params: { months },
  };
}

async function planRulesSave(api, {
  rule,
  existingRules,
  today,
  addDays,
  months = 24,
}) {
  const plan = await planRulesApply(api, {
    rules: [rule],
    merchantCatalog: [],
    catalogTypeMatch: {},
    resolveCatalogCategory: () => null,
    buildCatInfo: () => ({}),
    settleUpPayee: /$^/,
    reimbCat: /$^/,
    incomeGroup: /$^/,
    moneyMovementGroup: /$^/,
    today,
    addDays,
    months,
  });
  const nextRules = existingRules
    .filter((entry) => (entry.match || '').toLowerCase() !== (rule.match || '').toLowerCase());
  nextRules.push(rule);
  plan.items.push({
    globalIndex: plan.items.length,
    itemType: 'rules_sidecar',
    stageId: 'rules_sidecar',
    accountId: null,
    txnId: null,
    date: null,
    fingerprint: null,
    intent: {
      rules: nextRules,
      ruleId: rule.id,
      rulesFingerprint: canonicalRulesFingerprint(nextRules),
    },
  });
  plan.stages.push({
    stageId: 'rules_sidecar',
    itemIndexes: [plan.items.at(-1).globalIndex],
  });
  return plan;
}

async function planPhantomCleanup(api, {
  window,
  agedDays,
  observeDays,
  holdAgedDays,
  holdObserveDays,
  today,
  addDays,
  readPhantomSeen,
  payeeAlikeFn = payeeAlike,
}) {
  const start = addDays(today, -Math.abs(window));
  const payees = await api.getPayees();
  const payeeNames = Object.fromEntries(payees.map((payee) => [payee.id, payee.name || '']));
  const accounts = (await api.getAccounts()).filter((account) => !account.closed);
  const store = readPhantomSeen();
  const nowIso = new Date().toISOString();
  const items = [];
  const assignIndex = nextGlobalIndex(items);
  const liveIds = new Set();
  const deleteCandidates = [];
  const flaggedAged = [];

  for (const account of accounts) {
    const txns = await api.getTransactions(account.id, start, today);
    const pendings = txns.filter((txn) => txn.imported_id && txn.cleared === false && !txn.is_parent && !txn.parent_id);
    const cleared = txns.filter((txn) => txn.cleared === true && !txn.is_parent);
    for (const pending of pendings) {
      const id = String(pending.id);
      liveIds.add(id);
      const payee = payeeNames[pending.payee] || pending.imported_payee || '';
      const amount = d2(pending.amount);
      const prev = store.seen[id];
      const firstSeen = (prev && prev.firstSeen) || nowIso;
      const firstSeenDays = daysOld(String(firstSeen).slice(0, 10), today);
      items.push(assignIndex({
        itemType: 'phantom_seen',
        stageId: 'phantom_seen',
        accountId: String(account.id),
        txnId: id,
        date: String(pending.date),
        identityFingerprint: categoryIdentityFingerprint(pending),
        accountOpenAtPlan: !account.closed,
        intent: {
          firstSeen,
          lastSeen: nowIso,
          amount,
          date: pending.date,
          payee,
        },
      }));

      const superseder = cleared.find((candidate) => {
        if (candidate.id === pending.id) return false;
        const near = Math.abs(Math.abs(d2(candidate.amount)) - Math.abs(amount))
          <= Math.max(2, Math.abs(amount) * 0.30);
        return near
          && candidate.date >= addDays(pending.date, -1)
          && payeeAlikeFn(payee, payeeNames[candidate.payee] || candidate.imported_payee || '');
      });
      const dropOffHold = isDropOffHoldNote(pending);
      const noteProtected = hasKeepNote(pending) || (hasNote(pending) && !dropOffHold);
      let reason = null;
      if (superseder && !hasKeepNote(pending)) {
        reason = `superseded by cleared ${payeeNames[superseder.payee] || superseder.imported_payee || ''} ${d2(superseder.amount)} on ${superseder.date}`;
      } else if (!noteProtected && dropOffHold && daysOld(pending.date, today) >= holdAgedDays && firstSeenDays >= holdObserveDays) {
        reason = `dropped auth hold: hold/drop-off note, age ${daysOld(pending.date, today)}d, watched ${firstSeenDays}d`;
      } else if (!noteProtected && daysOld(pending.date, today) >= agedDays && firstSeenDays >= observeDays) {
        reason = `dropped hold: pending ${agedDays}d+ (age ${daysOld(pending.date, today)}d, watched ${firstSeenDays}d), no matching posted charge`;
      }
      if (!reason && !noteProtected && daysOld(pending.date, today) >= agedDays && firstSeenDays < observeDays) {
        flaggedAged.push({
          id,
          payee,
          amount,
          date: pending.date,
          watchedDays: firstSeenDays,
          needDays: observeDays,
        });
      }
      if (reason) {
        deleteCandidates.push({
          id,
          accountId: String(account.id),
          accountName: account.name,
          payee,
          amount,
          date: pending.date,
          reason,
          transaction: pending,
        });
      }
    }
  }

  for (const candidate of deleteCandidates) {
    items.push(assignIndex({
      itemType: 'phantom_delete',
      stageId: 'phantom_delete',
      accountId: candidate.accountId,
      txnId: candidate.id,
      date: String(candidate.date),
      identityFingerprint: categoryIdentityFingerprint(candidate.transaction),
      accountOpenAtPlan: true,
      intent: {
        reason: candidate.reason,
        accountName: candidate.accountName,
        payee: candidate.payee,
        amount: candidate.amount,
        date: candidate.date,
      },
    }));
  }

  for (const id of Object.keys(store.seen || {})) {
    if (liveIds.has(id) || deleteCandidates.some((candidate) => candidate.id === id)) continue;
    items.push(assignIndex({
      itemType: 'phantom_prune',
      stageId: 'phantom_prune',
      accountId: null,
      txnId: String(id),
      date: store.seen[id]?.date || null,
      fingerprint: null,
      intent: { seenKey: String(id) },
    }));
  }

  return {
    stages: [
      { stageId: 'phantom_seen', itemIndexes: items.filter((item) => item.itemType === 'phantom_seen').map((i) => i.globalIndex) },
      { stageId: 'phantom_delete', itemIndexes: items.filter((item) => item.itemType === 'phantom_delete').map((i) => i.globalIndex) },
      { stageId: 'phantom_prune', itemIndexes: items.filter((item) => item.itemType === 'phantom_prune').map((i) => i.globalIndex) },
    ],
    items,
    flaggedAged,
    params: { window, agedDays, observeDays, holdAgedDays, holdObserveDays, nowIso },
  };
}

function locateItemTransactionEverywhere(rowsByAccount, item) {
  if (!item?.txnId) return null;
  return locateExactTransactionIdInAccounts(rowsByAccount, item.txnId, item.accountId);
}

function foreignAccountIds(rowsByAccount, item) {
  const target = String(item?.txnId || '');
  if (!target) return [];
  const foreign = [];
  for (const [accountId, rows] of Object.entries(rowsByAccount || {})) {
    if (accountId === String(item.accountId)) continue;
    if (locateExactTransactionIdInAccounts({ [accountId]: rows }, target)) {
      foreign.push(accountId);
    }
  }
  return foreign;
}

function mirrorNeedsUpdate(existing, intent, accountId) {
  return !mirrorIntentMatches(existing, intent, accountId);
}

async function planSplitwiseMirror(api, {
  truth,
  resolutions,
  today,
  swAccountName,
  swCategoryName,
  pickSplitwiseCategory,
  buildCatInfo,
}) {
  const binding = snapshotBinding(truth);
  const resolutionBySource = resolutionIndex(resolutions);
  const items = [];
  const assignIndex = nextGlobalIndex(items);

  let accounts;
  try {
    accounts = await api.getAccounts();
  } catch (error) {
    throw new Error(`unable to enumerate Actual accounts during splitwise mirror planning: ${error.message}`);
  }
  if (!Array.isArray(accounts)) {
    throw new Error('Actual account enumeration was invalid during splitwise mirror planning');
  }

  let groups;
  try {
    groups = await api.getCategoryGroups();
  } catch (error) {
    throw new Error(`unable to enumerate category groups during splitwise mirror planning: ${error.message}`);
  }
  const structural = assertMirrorStructuralAdmission(accounts, groups, {
    accountName: swAccountName,
    categoryName: swCategoryName,
  });
  const foundAccount = structural.account;
  const accountOpenAtPlan = foundAccount ? !foundAccount.closed : true;
  const accountId = foundAccount ? String(foundAccount.id) : null;
  const catInfo = buildCatInfo(groups || []);
  const spendCats = [];
  for (const group of groups || []) {
    for (const category of group.categories || []) {
      if (catInfo[category.id] && catInfo[category.id].kind === 'spend') {
        spendCats.push({ id: category.id, name: category.name });
      }
    }
  }
  let fallbackCat = structural.category ? structural.category.id : null;

  let existingRows = [];
  if (accountId) {
    try {
      existingRows = await api.getTransactions(accountId, ACCOUNT_RANGE_START, ACCOUNT_RANGE_END);
    } catch (error) {
      throw new Error(`unable to query splitwise account during mirror planning: ${error.message}`);
    }
  }
  const bySource = indexMirrorRowsBySourceId(existingRows);
  assertNoMirrorAmbiguity(bySource, resolutions);

  items.push(assignIndex({
    itemType: 'splitwise_bootstrap_account',
    stageId: 'bootstrap_account',
    accountId: null,
    txnId: null,
    sourceId: null,
    bootstrapResourceKey: bootstrapAccountResourceKey(swAccountName),
    date: today,
    identityFingerprint: null,
    accountOpenAtPlan: true,
    intent: { accountName: swAccountName },
  }));

  items.push(assignIndex({
    itemType: 'splitwise_bootstrap_category',
    stageId: 'bootstrap_category',
    accountId: null,
    txnId: null,
    sourceId: null,
    bootstrapResourceKey: bootstrapCategoryResourceKey(swCategoryName),
    date: today,
    identityFingerprint: null,
    accountOpenAtPlan: true,
    intent: { categoryName: swCategoryName },
  }));

  const wanted = new Map();
  for (const item of truth.othersPaidItems || []) {
    const sourceId = String(item.id);
    const cents = myShareExpenseCents(item);
    if (!(cents < 0)) continue;
    const picked = pickSplitwiseCategory(item.category, spendCats);
    const catId = picked || fallbackCat || null;
    const useRuntimeCategoryFallback = !picked && !fallbackCat;
    wanted.set(sourceId, mirrorIntentFromItem(
      { ...item, date: item.date || today },
      accountId,
      catId,
      {
        useRuntimeCategoryFallback,
        accountPending: !accountId,
      },
    ));
  }

  for (const [sourceId, rows] of bySource.entries()) {
    const resolution = resolutionBySource.get(sourceId);
    if (!resolution || rows.length < 2) continue;
    for (const dropId of resolution.dropTxnIds) {
      const row = rows.find((entry) => String(entry.id) === String(dropId));
      if (!row) continue;
      items.push(assignIndex({
        itemType: 'splitwise_duplicate_drop',
        stageId: 'duplicate_drop',
        accountId: accountId || 'pending',
        txnId: String(row.id),
        sourceId,
        date: String(row.date),
        identityFingerprint: mirrorIdentityFingerprint(row, sourceId),
        accountOpenAtPlan,
        intent: {
          sourceId,
          resolutionReviewedAt: resolution.reviewedAt,
        },
      }));
    }
  }

  for (const [sourceId, rows] of bySource.entries()) {
    if (wanted.has(sourceId)) continue;
    const resolution = resolutionBySource.get(sourceId);
    const survivors = rows.filter((row) => !resolution?.dropTxnIds?.includes(String(row.id)));
    for (const row of survivors) {
      items.push(assignIndex({
        itemType: 'splitwise_delete',
        stageId: 'delete',
        accountId: accountId || 'pending',
        txnId: String(row.id),
        sourceId,
        date: String(row.date),
        identityFingerprint: mirrorIdentityFingerprint(row, sourceId),
        accountOpenAtPlan,
        intent: { sourceId, reason: 'removed-from-snapshot' },
      }));
    }
  }

  for (const [sourceId, intent] of wanted.entries()) {
    const rows = bySource.get(sourceId) || [];
    const resolution = resolutionBySource.get(sourceId);
    const keeper = keeperRowForSource(rows, resolution);
    if (!keeper) {
      items.push(assignIndex({
        itemType: 'splitwise_create',
        stageId: 'create',
        accountId: accountId || 'pending',
        txnId: null,
        sourceId,
        date: intent.date,
        identityFingerprint: null,
        accountOpenAtPlan,
        intent,
      }));
      continue;
    }
    if (mirrorNeedsUpdate(keeper, intent, accountId)) {
      items.push(assignIndex({
        itemType: 'splitwise_update',
        stageId: 'update',
        accountId: accountId || 'pending',
        txnId: String(keeper.id),
        sourceId,
        date: String(keeper.date),
        identityFingerprint: mirrorIdentityFingerprint(keeper, sourceId),
        accountOpenAtPlan,
        intent,
      }));
    }
  }

  const stageIndexes = (stageId) => items
    .filter((item) => item.stageId === stageId)
    .map((item) => item.globalIndex);

  return {
    stages: [
      { stageId: 'bootstrap_account', itemIndexes: stageIndexes('bootstrap_account') },
      { stageId: 'bootstrap_category', itemIndexes: stageIndexes('bootstrap_category') },
      { stageId: 'duplicate_drop', itemIndexes: stageIndexes('duplicate_drop') },
      { stageId: 'delete', itemIndexes: stageIndexes('delete') },
      { stageId: 'create', itemIndexes: stageIndexes('create') },
      { stageId: 'update', itemIndexes: stageIndexes('update') },
    ],
    items,
    params: {
      snapshotBinding: binding,
      snapshotItemCount: truth.othersPaidItems?.length || 0,
      accountName: swAccountName,
      categoryName: swCategoryName,
      resolutions,
      today,
    },
  };
}

module.exports = {
  ACCOUNT_RANGE_END,
  ACCOUNT_RANGE_START,
  foreignAccountIds,
  locateItemTransactionEverywhere,
  payeeAlike,
  planPhantomCleanup,
  planRulesApply,
  planRulesSave,
  planSplitwiseMirror,
};

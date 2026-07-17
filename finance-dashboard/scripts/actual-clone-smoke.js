#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.env.CLONE_MUTATION_TEST !== '1') {
  throw new Error('Refusing mutation smoke test without CLONE_MUTATION_TEST=1');
}
const server = new URL(process.env.ACTUAL_SERVER_URL || '');
if (!['127.0.0.1', 'localhost'].includes(server.hostname) || ['5006', ''].includes(server.port)) {
  throw new Error('Mutation smoke test requires a loopback clone on a non-production port');
}

const sidecars = fs.mkdtempSync(path.join(os.tmpdir(), 'darkfinances-clone-smoke-'));
for (const [key, file] of Object.entries({
  PERSONAL_CONFIG_PATH: 'personal.json',
  ACCOUNT_OVERRIDES_PATH: 'accounts.json',
  RECEIPTS_PATH: 'receipts.json',
  RECEIPTS_DIR: 'receipts',
  REIMB_LINKS_PATH: 'links.json',
  REIMB_SUGGEST_PATH: 'suggestions.json',
  RECON_PATH: 'reconciliation.json',
  PHANTOM_SEEN_PATH: 'phantom-seen.json',
  RULES_PATH: 'rules.json',
  TRANSACTION_SAGAS_PATH: 'transaction-sagas.json',
  TRANSACTION_DELETION_SAGAS_PATH: 'transaction-deletion-sagas.json',
  BULK_OPERATION_SAGAS_PATH: 'bulk-operation-sagas.json',
  SPLITWISE_MIRROR_RESOLUTIONS_PATH: 'splitwise-mirror-resolutions.json',
  REPAYMENT_CONFIRMATION_SAGAS_PATH: 'repayment-confirmation-sagas.json',
})) process.env[key] = path.join(sidecars, file);

const data = require('../dataModule');

(async () => {
  const marker = `DarkFinances clone smoke ${Date.now()}`;
  let account;
  try {
    await data.initApi();
    const accounts = await data.api.getAccounts();
    account = accounts.find((item) => !item.closed && !item.offbudget);
    if (!account) throw new Error('clone has no on-budget account');
    const groups = await data.api.getCategoryGroups();
    const category = groups.find((group) => !group.is_income)?.categories?.[0];
    if (!category) throw new Error('clone has no expense category');
    const date = process.env.TEST_DATE || new Date().toISOString().slice(0, 10);

    await data.createTransaction({
      accountId: account.id,
      amount: -12.34,
      payee: marker,
      date,
      categoryId: category.id,
      notes: '[clone-smoke]',
    });
    const payees = await data.api.getPayees();
    const payee = payees.find((item) => item.name === marker);
    const created = (await data.api.getTransactions(account.id, date, date))
      .find((item) => item.payee === payee?.id || item.imported_payee === marker);
    if (!created) throw new Error('manual transaction was not created');

    const split = await data.splitTransaction({
      id: created.id,
      accountId: account.id,
      date,
      legs: [
        { amount: -5, categoryId: category.id, notes: 'first' },
        { amount: -7.34, categoryId: category.id, notes: 'second' },
      ],
    });
    await data.syncNow();
    if (!split.id || split.id === created.id || split.legs !== 2) throw new Error('split did not return replacement identity');

    const detail = await data.getTransactionById({ id: split.id, accountId: account.id, date });
    if (!detail.isSplit || detail.legs.length !== 2) throw new Error('split detail is incomplete');

    const noteEdit = await data.setTransactionNotes({
      id: detail.legs[0].id,
      notes: 'updated',
      isLeg: true,
      parentId: detail.id,
      accountId: account.id,
      date,
    });
    await data.syncNow();
    if (!noteEdit.id || noteEdit.id === detail.legs[0].id) throw new Error('leg edit did not migrate identity');

    const editedLeg = await data.getTransactionById({ id: noteEdit.id, accountId: account.id, date });
    if (editedLeg.notes !== 'updated' || !editedLeg.isLeg) throw new Error('leg edit did not persist');

    const unsplit = await data.removeSplit({
      id: noteEdit.parentId,
      accountId: account.id,
      date,
      categoryId: category.id,
    });
    await data.syncNow();
    if (!unsplit.id) throw new Error('unsplit did not return replacement identity');
    const simple = await data.getTransactionById({ id: unsplit.id, accountId: account.id, date });
    if (simple.isSplit) throw new Error('transaction remained split');

    await data.deleteTransaction({ id: simple.id, accountId: account.id, date });
    await data.syncNow();
    console.log(JSON.stringify({ ok: true, splitIdChanged: true, legIdChanged: true, unsplitIdChanged: true }));
  } finally {
    if (account) {
      try {
        const today = process.env.TEST_DATE || new Date().toISOString().slice(0, 10);
        const payees = await data.api.getPayees();
        const payee = payees.find((item) => item.name === marker);
        const rows = await data.api.getTransactions(account.id, today, today);
        let deleted = false;
        for (const row of rows) {
          if (row.payee !== payee?.id && row.imported_payee !== marker) continue;
          await data.deleteTransaction({
            id: row.id,
            accountId: account.id,
            date: row.date,
            allowImported: true,
          });
          deleted = true;
        }
        if (deleted) await data.syncNow();
      } catch (_) {}
    }
    try { await data.api.shutdown(); } catch (_) {}
    fs.rmSync(sidecars, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});

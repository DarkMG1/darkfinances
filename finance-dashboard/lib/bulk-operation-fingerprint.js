'use strict';

const crypto = require('crypto');
const {
  canonicalTransactionSnapshot,
} = require('./transaction-deletion-saga');

function categoryIdentitySnapshot(transaction) {
  const snapshot = canonicalTransactionSnapshot(transaction);
  return {
    id: snapshot.id,
    parent_id: snapshot.parent_id,
    date: snapshot.date,
    amount: snapshot.amount,
    notes: snapshot.notes,
    payee: snapshot.payee,
    cleared: snapshot.cleared,
    imported_id: snapshot.imported_id,
    imported_payee: snapshot.imported_payee,
    transfer_id: snapshot.transfer_id,
    is_parent: snapshot.is_parent,
    subtransactions: snapshot.subtransactions,
  };
}

function categoryIdentityFingerprint(transaction) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(categoryIdentitySnapshot(transaction)))
    .digest('hex');
}

function categoryIntentMatches(transaction, intent) {
  if (!transaction || !intent) return false;
  return String(transaction.category || '') === String(intent.categoryId || '');
}

function categoryIdentityMatches(transaction, identityFingerprint) {
  return categoryIdentityFingerprint(transaction) === String(identityFingerprint || '');
}

function canonicalRule(rule) {
  return {
    id: String(rule?.id || ''),
    match: String(rule?.match || '').trim(),
    categoryId: String(rule?.categoryId || ''),
    categoryName: String(rule?.categoryName || ''),
    created: String(rule?.created || ''),
  };
}

function canonicalRulesFingerprint(rules) {
  return JSON.stringify(
    (rules || []).map(canonicalRule).sort((left, right) => left.id.localeCompare(right.id)),
  );
}

module.exports = {
  canonicalTransactionSnapshot,
  canonicalRule,
  canonicalRulesFingerprint,
  categoryIdentityFingerprint,
  categoryIdentityMatches,
  categoryIdentitySnapshot,
  categoryIntentMatches,
};

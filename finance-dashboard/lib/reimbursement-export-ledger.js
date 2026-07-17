'use strict';

const crypto = require('crypto');
const { KnownPreApplyError } = require('./errors');
const { FINANCE_TIME_ZONE } = require('./date-only');
const {
  buildLegacyMigrationReport,
  classifyStoredLink,
  endpointAdmissionFingerprint,
  linkPairKey,
  linkVersion,
  sameTransactionId,
  summarizeEndpointCapacity,
} = require('./reimbursement-allocation');

const EXPORT_SCHEMA_VERSION = 1;
const ALLOCATION_POLICY_VERSION = 'pr25-explicit-v1';
const MAX_SNAPSHOT_ATTEMPTS = 4;

class ExportSourceChangedError extends KnownPreApplyError {
  constructor(message = 'export source changed during snapshot — refresh and retry') {
    super(message, { code: 'EXPORT_SOURCE_CHANGED', status: 409 });
    this.name = 'ExportSourceChangedError';
  }
}

class ReimbursementExportIncompleteError extends KnownPreApplyError {
  constructor(message = 'reimbursement export is incomplete or ambiguous', payload = null) {
    super(message, { code: 'REIMBURSEMENT_EXPORT_INCOMPLETE', status: 409 });
    this.name = 'ReimbursementExportIncompleteError';
    this.payload = payload;
  }
}

function digestStableJson(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function compareText(a, b) {
  return String(a).localeCompare(String(b));
}

function sortLinks(links) {
  return [...(links || [])].sort((a, b) => compareText(
    linkPairKey(a?.inflow?.id, a?.expense?.id),
    linkPairKey(b?.inflow?.id, b?.expense?.id),
  ));
}

function csvEscape(value) {
  let s = String(value == null ? '' : value);
  if (/^[=+\-@]/.test(s.trimStart())) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function centsOrNull(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function endpointRefFromLive(live) {
  if (!live?.id) return null;
  return {
    id: String(live.id),
    date: live.date || null,
    payee: live.payee || '',
    amountCents: centsOrNull(live.amountCents),
    accountId: live.accountId || null,
    account: live.accountName || live.account || '',
    fingerprint: endpointAdmissionFingerprint(live),
  };
}

function endpointRefFromStored(ref, role) {
  if (!ref?.id) return null;
  let amountCents = null;
  if (ref.amount != null) {
    try {
      const { toCents } = require('./domain/money');
      amountCents = Math.abs(toCents(ref.amount));
      if (role === 'expense') amountCents = -amountCents;
    } catch (_) {
      amountCents = null;
    }
  }
  return {
    id: String(ref.id),
    date: ref.date || null,
    payee: ref.payee || '',
    amountCents,
    accountId: ref.accountId || null,
    account: ref.account || '',
    fingerprint: null,
  };
}

function inWindow(date, window) {
  if (!window?.from && !window?.to) return true;
  const value = String(date || '');
  if (window.from && value < window.from) return false;
  if (window.to && value > window.to) return false;
  return true;
}

function buildTrustedAllocationIndex(links) {
  const byExpense = {};
  const byInflow = {};
  const paymentsByExpense = {};
  for (const link of links || []) {
    const classified = classifyStoredLink(link);
    if (!classified.trusted) continue;
    const cents = classified.allocationCents;
    const expenseId = link?.expense?.id != null ? String(link.expense.id) : null;
    const inflowId = link?.inflow?.id != null ? String(link.inflow.id) : null;
    if (expenseId) {
      byExpense[expenseId] = (byExpense[expenseId] || 0) + cents;
      (paymentsByExpense[expenseId] = paymentsByExpense[expenseId] || []).push({
        id: inflowId,
        date: link?.inflow?.date || null,
        payee: link?.inflow?.payee || 'Payment',
        amountCents: cents,
        allocationTrusted: true,
        linkKey: linkPairKey(inflowId, expenseId),
      });
    }
    if (inflowId) byInflow[inflowId] = (byInflow[inflowId] || 0) + cents;
  }
  for (const list of Object.values(paymentsByExpense)) {
    list.sort((a, b) => compareText(a.date, b.date) || compareText(a.id, b.id));
  }
  return { byExpense, byInflow, paymentsByExpense };
}

function projectAllocationLedger({
  links,
  liveById = {},
  activeSagas = [],
  window = {},
  provenance = {},
  generatedAt,
  scanIncomplete = false,
}) {
  const completenessReasons = [];
  const incompleteSections = [];
  const sortedLinks = sortLinks(links);
  const legacyAmbiguity = buildLegacyMigrationReport(sortedLinks);
  if (generatedAt) legacyAmbiguity.generatedAt = generatedAt;
  const linkRows = [];
  const endpoints = {};
  const endpointIds = new Set();

  for (const link of sortedLinks) {
    const inflowId = link?.inflow?.id != null ? String(link.inflow.id) : null;
    const expenseId = link?.expense?.id != null ? String(link.expense.id) : null;
    if (inflowId) endpointIds.add(inflowId);
    if (expenseId) endpointIds.add(expenseId);

    const classified = classifyStoredLink(link);
    const liveInflow = inflowId ? liveById[inflowId] : null;
    const liveExpense = expenseId ? liveById[expenseId] : null;
    const inflowOrphan = inflowId != null && !liveInflow;
    const expenseOrphan = expenseId != null && !liveExpense;

    if (inflowOrphan) {
      completenessReasons.push({ code: 'orphaned_inflow', linkKey: linkPairKey(inflowId, expenseId), inflowId });
      incompleteSections.push({ section: 'orphaned_endpoints', linkKey: linkPairKey(inflowId, expenseId), endpointId: inflowId, role: 'inflow' });
    }
    if (expenseOrphan) {
      completenessReasons.push({ code: 'orphaned_expense', linkKey: linkPairKey(inflowId, expenseId), expenseId });
      incompleteSections.push({ section: 'orphaned_endpoints', linkKey: linkPairKey(inflowId, expenseId), endpointId: expenseId, role: 'expense' });
    }

    let fingerprintMismatch = false;
    if (liveInflow && link?.inflow) {
      const storedFp = endpointAdmissionFingerprint({
        id: link.inflow.id,
        accountId: link.inflow.accountId,
        date: link.inflow.date,
        amountCents: link.inflow.amount != null ? Math.round(Math.abs(Number(link.inflow.amount)) * 100) : null,
        category: null,
        isLeg: false,
        parentId: null,
      });
      const liveFp = endpointAdmissionFingerprint(liveInflow);
      if (storedFp && liveFp && storedFp !== liveFp) {
        fingerprintMismatch = true;
        completenessReasons.push({ code: 'endpoint_fingerprint_mismatch', linkKey: linkPairKey(inflowId, expenseId), endpointId: inflowId, role: 'inflow' });
      }
    }
    if (liveExpense && link?.expense) {
      const storedFp = endpointAdmissionFingerprint({
        id: link.expense.id,
        accountId: link.expense.accountId,
        date: link.expense.date,
        amountCents: link.expense.amount != null ? -Math.round(Math.abs(Number(link.expense.amount)) * 100) : null,
        category: null,
        isLeg: false,
        parentId: null,
      });
      const liveFp = endpointAdmissionFingerprint(liveExpense);
      if (storedFp && liveFp && storedFp !== liveFp) {
        fingerprintMismatch = true;
        completenessReasons.push({ code: 'endpoint_fingerprint_mismatch', linkKey: linkPairKey(inflowId, expenseId), endpointId: expenseId, role: 'expense' });
      }
    }

    const inWindowLink = (!window.from && !window.to)
      || (inWindow(link?.inflow?.date, window) && inWindow(link?.expense?.date, window));
    if (!inWindowLink && (window.from || window.to)) continue;

    linkRows.push({
      linkKey: link?.linkKey || linkPairKey(inflowId, expenseId),
      inflowId,
      expenseId,
      person: link?.person || null,
      allocationCents: classified.trusted ? classified.allocationCents : null,
      allocationTrusted: classified.trusted,
      allocationAmbiguous: classified.ambiguous,
      allocationReason: classified.reason,
      linkVersion: linkVersion(link),
      inflow: liveInflow ? endpointRefFromLive(liveInflow) : endpointRefFromStored(link?.inflow, 'inflow'),
      expense: liveExpense ? endpointRefFromLive(liveExpense) : endpointRefFromStored(link?.expense, 'expense'),
      inflowOrphan,
      expenseOrphan,
      fingerprintMismatch,
      createdAt: link?.createdAt || null,
      updatedAt: link?.updatedAt || null,
    });
  }

  for (const endpointId of [...endpointIds].sort(compareText)) {
    const live = liveById[endpointId];
    if (!live) {
      endpoints[endpointId] = {
        id: endpointId,
        role: null,
        live: false,
        absCapCents: null,
        allocatedTrustedCents: null,
        remainingTrustedCents: null,
        ambiguousLinkCount: null,
        completeness: 'missing',
        completenessReason: 'endpoint not found in live ledger scan',
      };
      continue;
    }
    const role = live.amountCents > 0 ? 'inflow' : 'expense';
    const capacity = summarizeEndpointCapacity({
      txnId: endpointId,
      txnAmountCents: live.amountCents,
      links: sortedLinks,
      role,
    });
    endpoints[endpointId] = {
      id: endpointId,
      role,
      live: true,
      absCapCents: capacity.absCapCents,
      allocatedTrustedCents: capacity.allocatedTrustedCents,
      remainingTrustedCents: capacity.remainingTrustedCents,
      ambiguousLinkCount: capacity.ambiguousLinkCount,
      completeness: capacity.completeness,
      completenessReason: capacity.completenessReason,
      fingerprint: endpointAdmissionFingerprint(live),
      date: live.date || null,
      payee: live.payee || '',
      amountCents: live.amountCents,
    };
    if (capacity.completeness !== 'complete') {
      completenessReasons.push({
        code: `endpoint_${capacity.completeness}`,
        endpointId,
        reason: capacity.completenessReason,
      });
      incompleteSections.push({
        section: 'endpoint_capacity',
        endpointId,
        completeness: capacity.completeness,
        reason: capacity.completenessReason,
      });
    }
  }

  if (legacyAmbiguity.ambiguousCount > 0) {
    completenessReasons.push({
      code: 'legacy_ambiguous_links',
      count: legacyAmbiguity.ambiguousCount,
    });
    incompleteSections.push({
      section: 'legacy_ambiguity',
      ambiguousCount: legacyAmbiguity.ambiguousCount,
      rows: legacyAmbiguity.rows,
    });
  }

  const nonterminal = (activeSagas || []).filter((saga) => saga && !saga.terminal);
  if (nonterminal.length > 0) {
    completenessReasons.push({
      code: 'active_reimbursement_link_saga',
      count: nonterminal.length,
      sagaIds: nonterminal.map((saga) => saga.id).sort(compareText),
    });
    incompleteSections.push({
      section: 'active_sagas',
      sagas: nonterminal.map((saga) => ({
        id: saga.id,
        phase: saga.phase,
        action: saga.action,
        inflowId: saga.inflowId || null,
        expenseId: saga.expenseId || null,
      })),
    });
  }

  if (scanIncomplete) {
    completenessReasons.push({ code: 'incomplete_ledger_scan' });
    incompleteSections.push({ section: 'ledger_scan', reason: 'live endpoint resolution did not complete' });
  }

  const dedupedReasons = [];
  const seen = new Set();
  for (const reason of completenessReasons) {
    const key = stableStringify(reason);
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedReasons.push(reason);
  }
  dedupedReasons.sort((a, b) => compareText(a.code, b.code) || compareText(stableStringify(a), stableStringify(b)));

  const people = {};
  for (const row of linkRows) {
    if (!row.allocationTrusted || row.allocationCents == null) continue;
    const slug = row.person || '(unassigned)';
    people[slug] = (people[slug] || 0) + row.allocationCents;
  }
  const peopleRows = Object.entries(people)
    .map(([person, allocatedTrustedCents]) => ({ person, allocatedTrustedCents }))
    .sort((a, b) => compareText(a.person, b.person));

  let trustedAllocationCents = 0;
  for (const row of linkRows) {
    if (row.allocationTrusted && row.allocationCents != null) {
      trustedAllocationCents += row.allocationCents;
    }
  }

  const authoritative = dedupedReasons.length === 0;
  const status = authoritative ? 'complete' : 'incomplete';

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    allocationPolicyVersion: ALLOCATION_POLICY_VERSION,
    generatedAt: generatedAt || new Date().toISOString(),
    financeTimeZone: FINANCE_TIME_ZONE,
    window: {
      from: window.from || null,
      to: window.to || null,
    },
    provenance: {
      actualGeneration: provenance.actualGeneration ?? null,
      release: provenance.release ?? null,
      linksSidecarDigest: provenance.linksSidecarDigest ?? null,
      inputDigests: provenance.inputDigests ?? {},
      operationBinding: provenance.operationBinding ?? null,
    },
    completeness: {
      status,
      reasons: dedupedReasons,
    },
    totals: {
      trustedAllocationCents: authoritative ? trustedAllocationCents : null,
      linkCount: linkRows.length,
      trustedLinkCount: linkRows.filter((row) => row.allocationTrusted).length,
      ambiguousLinkCount: linkRows.filter((row) => row.allocationAmbiguous).length,
      authoritative,
    },
    links: linkRows,
    endpoints,
    people: peopleRows,
    legacyAmbiguity,
    incompleteSections: incompleteSections.sort((a, b) => compareText(stableStringify(a), stableStringify(b))),
  };
}

function exportExitCode(payload) {
  if (!payload) return 1;
  return payload.completeness?.status === 'complete' ? 0 : 2;
}

function assertExportConservation(payload) {
  const inflowTotals = {};
  const expenseTotals = {};
  for (const row of payload?.links || []) {
    if (!row.allocationTrusted || row.allocationCents == null) continue;
    if (row.inflowId) inflowTotals[row.inflowId] = (inflowTotals[row.inflowId] || 0) + row.allocationCents;
    if (row.expenseId) expenseTotals[row.expenseId] = (expenseTotals[row.expenseId] || 0) + row.allocationCents;
  }
  for (const [endpointId, endpoint] of Object.entries(payload?.endpoints || {})) {
    if (!endpoint.live || endpoint.absCapCents == null) continue;
    const allocated = endpoint.role === 'inflow'
      ? (inflowTotals[endpointId] || 0)
      : (expenseTotals[endpointId] || 0);
    if (allocated > endpoint.absCapCents) {
      throw new Error(`conservation violation on ${endpointId}: allocated ${allocated} > cap ${endpoint.absCapCents}`);
    }
  }
}

function formatReimbursementExportCsv(payload) {
  const lines = [
    `# schemaVersion,${payload.schemaVersion}`,
    `# allocationPolicyVersion,${payload.allocationPolicyVersion}`,
    `# generatedAt,${payload.generatedAt}`,
    `# financeTimeZone,${payload.financeTimeZone}`,
    `# completeness,${payload.completeness.status}`,
    `# authoritativeTotals,${payload.totals.authoritative}`,
    'linkKey,inflowId,expenseId,person,allocationCents,allocationTrusted,allocationAmbiguous,allocationReason,linkVersion,inflowDate,expenseDate,inflowAmountCents,expenseAmountCents,inflowRemainingTrustedCents,expenseRemainingTrustedCents,inflowOrphan,expenseOrphan',
  ];
  for (const row of payload.links) {
    const inflowCap = row.inflowId ? payload.endpoints[row.inflowId] : null;
    const expenseCap = row.expenseId ? payload.endpoints[row.expenseId] : null;
    lines.push([
      csvEscape(row.linkKey),
      csvEscape(row.inflowId),
      csvEscape(row.expenseId),
      csvEscape(row.person),
      row.allocationCents == null ? '' : row.allocationCents,
      row.allocationTrusted,
      row.allocationAmbiguous,
      csvEscape(row.allocationReason),
      row.linkVersion,
      csvEscape(row.inflow?.date),
      csvEscape(row.expense?.date),
      row.inflow?.amountCents == null ? '' : row.inflow.amountCents,
      row.expense?.amountCents == null ? '' : row.expense.amountCents,
      inflowCap?.remainingTrustedCents == null ? '' : inflowCap.remainingTrustedCents,
      expenseCap?.remainingTrustedCents == null ? '' : expenseCap.remainingTrustedCents,
      row.inflowOrphan,
      row.expenseOrphan,
    ].join(','));
  }
  return `${lines.join('\n')}\n`;
}

function formatReimbursementExportHuman(payload) {
  const lines = [];
  lines.push(`REIMBURSEMENT ALLOCATION EXPORT — ${payload.window.from || 'all'} through ${payload.window.to || 'today'}`);
  lines.push(`Generated: ${payload.generatedAt} (${payload.financeTimeZone})`);
  lines.push(`Policy: ${payload.allocationPolicyVersion} · schema v${payload.schemaVersion}`);
  lines.push(`Completeness: ${payload.completeness.status}${payload.totals.authoritative ? '' : ' (authoritative totals withheld)'}`);
  if (payload.provenance.actualGeneration != null) {
    lines.push(`Actual generation: ${payload.provenance.actualGeneration}`);
  }
  if (payload.provenance.release?.version) {
    lines.push(`Release: ${payload.provenance.release.version}`);
  }
  if (payload.completeness.reasons.length) {
    lines.push('');
    lines.push('INCOMPLETE / AMBIGUOUS');
    for (const reason of payload.completeness.reasons) {
      lines.push(`  - ${reason.code}${reason.count != null ? ` (${reason.count})` : ''}`);
    }
  }
  lines.push('');
  if (payload.totals.authoritative) {
    lines.push(`Trusted allocations: ${(payload.totals.trustedAllocationCents / 100).toFixed(2)} across ${payload.totals.trustedLinkCount} link(s)`);
  } else {
    lines.push('Trusted allocation total: unavailable (incomplete export)');
  }
  lines.push('');
  for (const row of payload.links) {
    const alloc = row.allocationTrusted && row.allocationCents != null
      ? `$${(row.allocationCents / 100).toFixed(2)}`
      : 'ambiguous';
    lines.push(`${row.linkKey}: ${alloc} · person=${row.person || '(none)'} · v${row.linkVersion}`);
    if (row.allocationAmbiguous) lines.push(`  reason: ${row.allocationReason}`);
    if (row.inflowOrphan || row.expenseOrphan) lines.push('  orphan: live endpoint missing');
  }
  if (!payload.links.length) lines.push('No reimbursement links in scope.');
  return `${lines.join('\n')}\n`;
}

function redactExportPayload(payload) {
  const clone = JSON.parse(JSON.stringify(payload));
  delete clone.secrets;
  delete clone.receiptBytes;
  return clone;
}

module.exports = {
  ALLOCATION_POLICY_VERSION,
  EXPORT_SCHEMA_VERSION,
  ExportSourceChangedError,
  MAX_SNAPSHOT_ATTEMPTS,
  ReimbursementExportIncompleteError,
  assertExportConservation,
  buildTrustedAllocationIndex,
  csvEscape,
  digestStableJson,
  exportExitCode,
  formatReimbursementExportCsv,
  formatReimbursementExportHuman,
  projectAllocationLedger,
  redactExportPayload,
  sortLinks,
  stableStringify,
};

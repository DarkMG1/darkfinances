'use strict';

const { FINANCE_TIME_ZONE, daysBetween } = require('./date-only');
const {
  ALLOCATION_POLICY_VERSION,
  EXPORT_SCHEMA_VERSION,
  ExportSourceChangedError,
  MAX_EXPORT_FIELD_LENGTH,
  MAX_EXPORT_LINKS,
  MAX_EXPORT_SERIALIZED_BYTES,
  MAX_EXPORT_WINDOW_SPAN_DAYS,
  MAX_SNAPSHOT_ATTEMPTS,
  ReimbursementExportBoundsError,
  ReimbursementExportIncompleteError,
  buildReimbursementExportV1Envelope,
  collectLeakedAuthoritativeCents,
  digestStableJson,
  exportExitCodeFromPayload,
  stableStringify,
  summarizeExportIncompleteForError,
  withholdAuthoritativeExportPayload,
} = require('./reimbursement-export-common');
const {
  buildLegacyMigrationReport,
  classifyStoredLink,
  endpointAdmissionFingerprint,
  assessLiveReimbursementEndpoint,
  linkPairKey,
  linkVersion,
  liveEndpointIdentityFingerprint,
  storedEndpointIdentityFingerprint,
  summarizeEndpointCapacity,
} = require('./reimbursement-allocation');

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const BIDI_RE = /[\u202a-\u202e\u2066-\u2069\ufeff]/g;
const CONTROL_RE = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`, 'g');
const SENSITIVE_EXPORT_KEYS = new Set([
  'secrets',
  'receiptBytes',
  'receipt',
  'receipts',
  'password',
  'token',
  'apiKey',
  'authorization',
  'ocrText',
]);

function compareText(a, b) {
  return String(a).localeCompare(String(b));
}

function sortLinks(links) {
  return [...(links || [])].sort((a, b) => compareText(
    linkPairKey(a?.inflow?.id, a?.expense?.id),
    linkPairKey(b?.inflow?.id, b?.expense?.id),
  ));
}

function truncateField(value) {
  if (value == null) return value;
  const text = String(value);
  return text.length <= MAX_EXPORT_FIELD_LENGTH ? text : text.slice(0, MAX_EXPORT_FIELD_LENGTH);
}

function sanitizeHumanText(value) {
  return truncateField(String(value ?? '')
    .replace(ANSI_RE, '')
    .replace(BIDI_RE, '')
    .replace(CONTROL_RE, ''));
}

function csvEscape(value) {
  let s = sanitizeHumanText(value == null ? '' : value);
  if (/^[=+\-@]/.test(s.trimStart())) s = `'${s}`;
  return /[",\n\r\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function centsOrNull(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function endpointRefFromLive(live) {
  if (!live?.id) return null;
  return {
    id: String(live.id),
    date: live.date || null,
    payee: truncateField(live.payee || ''),
    amountCents: centsOrNull(live.amountCents),
    accountId: live.accountId || null,
    account: truncateField(live.accountName || live.account || ''),
    identityFingerprint: liveEndpointIdentityFingerprint(live),
    admissionFingerprint: endpointAdmissionFingerprint(live),
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
    payee: truncateField(ref.payee || ''),
    amountCents,
    accountId: ref.accountId || null,
    account: truncateField(ref.account || ''),
    categoryId: ref.categoryId ?? ref.category ?? null,
    identityFingerprint: storedEndpointIdentityFingerprint(ref, role),
    admissionFingerprint: null,
  };
}

function inWindow(date, window) {
  if (!window?.from && !window?.to) return true;
  const value = String(date || '');
  if (window.from && value < window.from) return false;
  if (window.to && value > window.to) return false;
  return true;
}

function linkInWindow(link, window) {
  if (!window?.from && !window?.to) return true;
  return inWindow(link?.inflow?.date, window) && inWindow(link?.expense?.date, window);
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

function sumTrustedForLinks(linkRows) {
  let total = 0;
  for (const row of linkRows) {
    if (row.allocationTrusted && row.allocationCents != null) total += row.allocationCents;
  }
  return total;
}

function withholdAuthoritativeNumbers(payload) {
  return withholdAuthoritativeExportPayload(payload);
}

function assertScopeConservation(payload) {
  const globalRows = payload?.scopes?.global?.links || payload?.links || [];
  const inflowTotals = {};
  const expenseTotals = {};
  for (const row of globalRows) {
    if (!row.allocationTrusted || row.allocationCents == null) continue;
    if (row.inflowId) inflowTotals[row.inflowId] = (inflowTotals[row.inflowId] || 0) + row.allocationCents;
    if (row.expenseId) expenseTotals[row.expenseId] = (expenseTotals[row.expenseId] || 0) + row.allocationCents;
  }
  for (const [endpointId, endpoint] of Object.entries(payload?.endpoints || {})) {
    const global = endpoint?.global;
    if (!endpoint.live || !global || global.absCapCents == null) continue;
    const allocated = endpoint.role === 'inflow'
      ? (inflowTotals[endpointId] || 0)
      : (expenseTotals[endpointId] || 0);
    if (global.allocatedTrustedCents != null && allocated !== global.allocatedTrustedCents) {
      throw new Error(`global conservation mismatch on ${endpointId}: links ${allocated} != endpoint ${global.allocatedTrustedCents}`);
    }
    if (allocated > global.absCapCents) {
      throw new Error(`global conservation violation on ${endpointId}: allocated ${allocated} > cap ${global.absCapCents}`);
    }
    if (global.remainingTrustedCents != null && global.allocatedTrustedCents != null) {
      const expectedRemaining = global.absCapCents - global.allocatedTrustedCents;
      if (global.remainingTrustedCents !== expectedRemaining) {
        throw new Error(`global remaining mismatch on ${endpointId}`);
      }
    }
  }

  const windowActive = Boolean(payload?.window?.from || payload?.window?.to);
  if (!windowActive) return;

  const windowRows = payload?.scopes?.window?.links || payload?.links || [];
  const windowInflowTotals = {};
  const windowExpenseTotals = {};
  for (const row of windowRows) {
    if (!row.allocationTrusted || row.allocationCents == null) continue;
    if (row.inflowId) windowInflowTotals[row.inflowId] = (windowInflowTotals[row.inflowId] || 0) + row.allocationCents;
    if (row.expenseId) windowExpenseTotals[row.expenseId] = (windowExpenseTotals[row.expenseId] || 0) + row.allocationCents;
  }
  const windowTotal = sumTrustedForLinks(windowRows);
  if (payload.scopes?.window?.totals?.trustedAllocationCents != null
    && windowTotal !== payload.scopes.window.totals.trustedAllocationCents) {
    throw new Error('window trustedAllocationCents does not match link sum');
  }
  for (const [endpointId, endpoint] of Object.entries(payload?.endpoints || {})) {
    const windowScope = endpoint?.window;
    if (!windowScope || windowScope.allocatedTrustedCents == null) continue;
    const allocated = endpoint.role === 'inflow'
      ? (windowInflowTotals[endpointId] || 0)
      : (windowExpenseTotals[endpointId] || 0);
    if (allocated !== windowScope.allocatedTrustedCents) {
      throw new Error(`window conservation mismatch on ${endpointId}`);
    }
  }
}

function assertExportConservation(payload) {
  assertScopeConservation(payload);
}

function finalizeExportPayload(payload) {
  if (payload?.completeness?.status === 'complete') {
    assertExportConservation(payload);
    return payload;
  }
  return withholdAuthoritativeNumbers(payload);
}

function assertExportWindowBounds(window = {}) {
  const { from, to } = window;
  if (from && to && from > to) {
    throw new ReimbursementExportBoundsError('export window from must be on or before to');
  }
  if (from && to) {
    const span = daysBetween(from, to);
    if (span > MAX_EXPORT_WINDOW_SPAN_DAYS) {
      throw new ReimbursementExportBoundsError('export window span exceeds maximum');
    }
  }
}

function assertExportInputBounds({ links, window }) {
  assertExportWindowBounds(window);
  if ((links || []).length > MAX_EXPORT_LINKS) {
    throw new ReimbursementExportBoundsError('export link count exceeds maximum');
  }
}

function assertExportSerializedBounds(payload) {
  const bytes = Buffer.byteLength(stableStringify(payload), 'utf8');
  if (bytes > MAX_EXPORT_SERIALIZED_BYTES) {
    throw new ReimbursementExportBoundsError('serialized export exceeds maximum bytes');
  }
}

function prepareExportForPublish(payload, { strict = false } = {}) {
  const finalized = finalizeExportPayload(payload);
  assertExportSerializedBounds(finalized);
  if (strict && finalized.completeness.status !== 'complete') {
    throw new ReimbursementExportIncompleteError(
      'strict export refused incomplete reimbursement allocation ledger',
      summarizeExportIncompleteForError(finalized),
    );
  }
  return redactExportPayload(finalized);
}

function projectAllocationLedger({
  links,
  liveById = {},
  activeSagas = [],
  window = {},
  provenance = {},
  generatedAt,
  scanIncomplete = false,
  reimbCategoryId = null,
}) {
  assertExportInputBounds({ links, window });
  const completenessReasons = [];
  const incompleteSections = [];
  const sortedLinks = sortLinks(links);
  const legacyAmbiguity = buildLegacyMigrationReport(sortedLinks);
  if (generatedAt) legacyAmbiguity.generatedAt = generatedAt;
  const allLinkRows = [];
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

    let identityMismatch = false;
    let eligibilityMismatch = false;
    if (liveInflow && link?.inflow) {
      const storedIdentity = storedEndpointIdentityFingerprint(link.inflow, 'inflow');
      const liveIdentity = liveEndpointIdentityFingerprint(liveInflow);
      if (storedIdentity && liveIdentity && storedIdentity !== liveIdentity) {
        identityMismatch = true;
        completenessReasons.push({ code: 'endpoint_identity_mismatch', linkKey: linkPairKey(inflowId, expenseId), endpointId: inflowId, role: 'inflow' });
      }
      const eligibility = assessLiveReimbursementEndpoint(liveInflow, { reimbCategoryId, role: 'inflow' });
      if (!eligibility.eligible) {
        eligibilityMismatch = true;
        completenessReasons.push({
          code: 'endpoint_reimbursement_ineligible',
          linkKey: linkPairKey(inflowId, expenseId),
          endpointId: inflowId,
          role: 'inflow',
          reason: eligibility.reason,
        });
      }
    }
    if (liveExpense && link?.expense) {
      const storedIdentity = storedEndpointIdentityFingerprint(link.expense, 'expense');
      const liveIdentity = liveEndpointIdentityFingerprint(liveExpense);
      if (storedIdentity && liveIdentity && storedIdentity !== liveIdentity) {
        identityMismatch = true;
        completenessReasons.push({ code: 'endpoint_identity_mismatch', linkKey: linkPairKey(inflowId, expenseId), endpointId: expenseId, role: 'expense' });
      }
      const eligibility = assessLiveReimbursementEndpoint(liveExpense, { reimbCategoryId, role: 'expense' });
      if (!eligibility.eligible) {
        eligibilityMismatch = true;
        completenessReasons.push({
          code: 'endpoint_reimbursement_ineligible',
          linkKey: linkPairKey(inflowId, expenseId),
          endpointId: expenseId,
          role: 'expense',
          reason: eligibility.reason,
        });
      }
    }

    allLinkRows.push({
      linkKey: link?.linkKey || linkPairKey(inflowId, expenseId),
      inflowId,
      expenseId,
      person: truncateField(link?.person || null),
      allocationCents: classified.trusted ? classified.allocationCents : null,
      allocationTrusted: classified.trusted,
      allocationAmbiguous: classified.ambiguous,
      allocationReason: classified.reason,
      linkVersion: linkVersion(link),
      inflow: liveInflow ? endpointRefFromLive(liveInflow) : endpointRefFromStored(link?.inflow, 'inflow'),
      expense: liveExpense ? endpointRefFromLive(liveExpense) : endpointRefFromStored(link?.expense, 'expense'),
      inflowOrphan,
      expenseOrphan,
      identityMismatch,
      eligibilityMismatch,
      createdAt: link?.createdAt || null,
      updatedAt: link?.updatedAt || null,
    });
  }

  const windowActive = Boolean(window.from || window.to);
  const linkRows = windowActive
    ? allLinkRows.filter((row) => {
      const source = sortedLinks.find((link) => linkPairKey(link?.inflow?.id, link?.expense?.id) === row.linkKey);
      return source ? linkInWindow(source, window) : false;
    })
    : allLinkRows;

  const endpoints = {};
  for (const endpointId of [...endpointIds].sort(compareText)) {
    const live = liveById[endpointId];
    if (!live) {
      endpoints[endpointId] = {
        id: endpointId,
        role: null,
        live: false,
        global: {
          absCapCents: null,
          allocatedTrustedCents: null,
          remainingTrustedCents: null,
          ambiguousLinkCount: null,
          completeness: 'missing',
          completenessReason: 'endpoint not found in live ledger scan',
        },
        window: windowActive ? {
          allocatedTrustedCents: null,
          linkCountLowerBound: 0,
        } : null,
      };
      continue;
    }
    const role = live.amountCents > 0 ? 'inflow' : 'expense';
    const globalCapacity = summarizeEndpointCapacity({
      txnId: endpointId,
      txnAmountCents: live.amountCents,
      links: sortedLinks,
      role,
    });
    const windowLinks = windowActive
      ? sortedLinks.filter((link) => linkInWindow(link, window))
      : sortedLinks;
    const windowCapacity = summarizeEndpointCapacity({
      txnId: endpointId,
      txnAmountCents: live.amountCents,
      links: windowLinks,
      role,
    });
    endpoints[endpointId] = {
      id: endpointId,
      role,
      live: true,
      date: live.date || null,
      payee: truncateField(live.payee || ''),
      amountCents: live.amountCents,
      global: {
        absCapCents: globalCapacity.absCapCents,
        allocatedTrustedCents: globalCapacity.allocatedTrustedCents,
        remainingTrustedCents: globalCapacity.remainingTrustedCents,
        ambiguousLinkCount: globalCapacity.ambiguousLinkCount,
        completeness: globalCapacity.completeness,
        completenessReason: globalCapacity.completenessReason,
      },
      window: windowActive ? {
        allocatedTrustedCents: windowCapacity.allocatedTrustedCents,
        linkCountLowerBound: windowLinks.filter(
          (link) => String(link?.inflow?.id) === endpointId || String(link?.expense?.id) === endpointId,
        ).length,
      } : null,
    };
    if (globalCapacity.completeness !== 'complete') {
      completenessReasons.push({
        code: `endpoint_${globalCapacity.completeness}`,
        endpointId,
        reason: globalCapacity.completenessReason,
      });
      incompleteSections.push({
        section: 'endpoint_capacity',
        endpointId,
        scope: 'global',
        completeness: globalCapacity.completeness,
        reason: globalCapacity.completenessReason,
      });
    }
  }

  if (legacyAmbiguity.ambiguousCount > 0) {
    completenessReasons.push({ code: 'legacy_ambiguous_links', count: legacyAmbiguity.ambiguousCount });
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

  const globalTrustedAllocationCents = sumTrustedForLinks(allLinkRows);
  const windowTrustedAllocationCents = sumTrustedForLinks(linkRows);
  const authoritative = dedupedReasons.length === 0;
  const status = authoritative ? 'complete' : 'incomplete';

  const payload = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    allocationPolicyVersion: ALLOCATION_POLICY_VERSION,
    generatedAt: generatedAt || new Date().toISOString(),
    financeTimeZone: FINANCE_TIME_ZONE,
    window: {
      from: window.from || null,
      to: window.to || null,
    },
    scopes: {
      window: {
        active: windowActive,
        totals: {
          trustedAllocationCents: authoritative ? windowTrustedAllocationCents : null,
          linkCount: linkRows.length,
          trustedLinkCountLowerBound: linkRows.filter((row) => row.allocationTrusted).length,
          ambiguousLinkCountLowerBound: linkRows.filter((row) => row.allocationAmbiguous).length,
          authoritative,
        },
        links: linkRows,
      },
      global: {
        totals: {
          trustedAllocationCents: authoritative ? globalTrustedAllocationCents : null,
          linkCount: allLinkRows.length,
          trustedLinkCountLowerBound: allLinkRows.filter((row) => row.allocationTrusted).length,
          ambiguousLinkCountLowerBound: allLinkRows.filter((row) => row.allocationAmbiguous).length,
          authoritative,
        },
        links: allLinkRows,
      },
    },
    provenance: {
      actualGeneration: provenance.actualGeneration ?? null,
      linksRevision: provenance.linksRevision ?? null,
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
      trustedAllocationCents: authoritative ? (windowActive ? windowTrustedAllocationCents : globalTrustedAllocationCents) : null,
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

  return payload;
}

function exportExitCode(payload) {
  return exportExitCodeFromPayload(payload);
}

function formatReimbursementExportCsv(payload) {
  const lines = [
    `# schemaVersion,${payload.schemaVersion}`,
    `# allocationPolicyVersion,${payload.allocationPolicyVersion}`,
    `# generatedAt,${payload.generatedAt}`,
    `# financeTimeZone,${payload.financeTimeZone}`,
    `# completeness,${payload.completeness.status}`,
    `# authoritativeTotals,${payload.totals.authoritative}`,
    'linkKey,inflowId,expenseId,person,allocationCents,allocationTrusted,allocationAmbiguous,allocationReason,linkVersion,inflowDate,expenseDate,inflowAmountCents,expenseAmountCents,inflowGlobalRemainingTrustedCents,expenseGlobalRemainingTrustedCents,inflowWindowAllocatedTrustedCents,expenseWindowAllocatedTrustedCents,inflowOrphan,expenseOrphan',
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
      inflowCap?.global?.remainingTrustedCents == null ? '' : inflowCap.global.remainingTrustedCents,
      expenseCap?.global?.remainingTrustedCents == null ? '' : expenseCap.global.remainingTrustedCents,
      inflowCap?.window?.allocatedTrustedCents == null ? '' : inflowCap.window.allocatedTrustedCents,
      expenseCap?.window?.allocatedTrustedCents == null ? '' : expenseCap.window.allocatedTrustedCents,
      row.inflowOrphan,
      row.expenseOrphan,
    ].join(','));
  }
  return `${lines.join('\n')}\n`;
}

function formatReimbursementExportHuman(payload) {
  const lines = [];
  lines.push(sanitizeHumanText(`REIMBURSEMENT ALLOCATION EXPORT — ${payload.window.from || 'all'} through ${payload.window.to || 'today'}`));
  lines.push(sanitizeHumanText(`Generated: ${payload.generatedAt} (${payload.financeTimeZone})`));
  lines.push(sanitizeHumanText(`Policy: ${payload.allocationPolicyVersion} · schema v${payload.schemaVersion}`));
  lines.push(sanitizeHumanText(`Completeness: ${payload.completeness.status}${payload.totals.authoritative ? '' : ' (authoritative totals withheld)'}`));
  if (payload.provenance.actualGeneration != null) {
    lines.push(sanitizeHumanText(`Actual generation: ${payload.provenance.actualGeneration}`));
  }
  if (payload.provenance.release?.version) {
    lines.push(sanitizeHumanText(`Release: ${payload.provenance.release.version}`));
  }
  if (payload.completeness.reasons.length) {
    lines.push('');
    lines.push('INCOMPLETE / AMBIGUOUS');
    for (const reason of payload.completeness.reasons) {
      lines.push(sanitizeHumanText(`  - ${reason.code}${reason.count != null ? ` (${reason.count})` : ''}`));
    }
  }
  lines.push('');
  if (payload.totals.authoritative) {
    lines.push(sanitizeHumanText(`Trusted allocations: ${(payload.totals.trustedAllocationCents / 100).toFixed(2)} across ${payload.totals.trustedLinkCount} link(s)`));
    if (payload.scopes?.global?.totals?.authoritative) {
      lines.push(sanitizeHumanText(`Global trusted allocations: ${(payload.scopes.global.totals.trustedAllocationCents / 100).toFixed(2)} across ${payload.scopes.global.totals.linkCount} link(s)`));
    }
  } else {
    lines.push('Trusted allocation total: unavailable (incomplete export)');
  }
  lines.push('');
  for (const row of payload.links) {
    const alloc = row.allocationTrusted && row.allocationCents != null
      ? `$${(row.allocationCents / 100).toFixed(2)}`
      : 'ambiguous';
    lines.push(sanitizeHumanText(`${row.linkKey}: ${alloc} · person=${row.person || '(none)'} · v${row.linkVersion}`));
    if (row.allocationAmbiguous) lines.push(sanitizeHumanText(`  reason: ${row.allocationReason}`));
    if (row.inflowOrphan || row.expenseOrphan) lines.push('  orphan: live endpoint missing');
  }
  if (!payload.links.length) lines.push('No reimbursement links in scope.');
  return `${lines.join('\n')}\n`;
}

function redactExportPayload(payload) {
  function walk(value, key = null) {
    if (value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((entry) => walk(entry));
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (SENSITIVE_EXPORT_KEYS.has(childKey)) continue;
      if (typeof childValue === 'string') {
        out[childKey] = truncateField(childValue);
      } else {
        out[childKey] = walk(childValue, childKey);
      }
    }
    if (key === 'legacyAmbiguity' && out.rows) {
      out.rows = out.rows.map((row) => ({
        linkKey: row.linkKey,
        reason: row.reason,
      }));
    }
    return out;
  }
  return walk(payload);
}

module.exports = {
  ALLOCATION_POLICY_VERSION,
  EXPORT_SCHEMA_VERSION,
  ExportSourceChangedError,
  MAX_EXPORT_FIELD_LENGTH,
  MAX_EXPORT_LINKS,
  MAX_EXPORT_SERIALIZED_BYTES,
  MAX_EXPORT_WINDOW_SPAN_DAYS,
  MAX_SNAPSHOT_ATTEMPTS,
  ReimbursementExportBoundsError,
  ReimbursementExportIncompleteError,
  assertExportConservation,
  assertExportInputBounds,
  assertExportSerializedBounds,
  assertExportWindowBounds,
  buildReimbursementExportV1Envelope,
  buildTrustedAllocationIndex,
  collectLeakedAuthoritativeCents,
  csvEscape,
  digestStableJson,
  exportExitCode,
  finalizeExportPayload,
  formatReimbursementExportCsv,
  formatReimbursementExportHuman,
  prepareExportForPublish,
  projectAllocationLedger,
  redactExportPayload,
  sanitizeHumanText,
  sortLinks,
  stableStringify,
  withholdAuthoritativeNumbers,
};

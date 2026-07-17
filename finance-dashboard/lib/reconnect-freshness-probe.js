'use strict';

const crypto = require('crypto');

const PROBE_KIND = 'actual-direct-accounts';
const ACCOUNTS_CACHE_KEY = 'accounts';
const ACCOUNTS_CACHE_TTL = 300;

function deriveSourceObservedRevision(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  const parts = accounts
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      const id = entry.id ?? '';
      const name = entry.name ?? '';
      const balance = entry.balance ?? entry.balanceCents ?? '';
      return `${id}\u0000${name}\u0000${balance}`;
    })
    .sort();
  return crypto.createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 16);
}

function createReconnectFreshnessProbeService(deps) {
  const coordinator = deps.coordinator;
  const readAccountsProbe = deps.readAccountsProbe;
  const financeTimeZone = deps.financeTimeZone;
  const deployIdentity = deps.deployIdentity ?? (() => null);
  const now = deps.now ?? (() => Date.now());

  /** @type {Promise<Record<string, unknown>> | null} */
  let inFlight = null;

  async function performProbe() {
    return coordinator.runRead(async () => {
      const cacheGenerationBefore = coordinator.generation;
      const sourceObservedAt = now();
      const accounts = await readAccountsProbe();
      const sourceObservedRevision = deriveSourceObservedRevision(accounts);
      const cacheGenerationAfter = coordinator.invalidateGeneration();
      coordinator.publishCacheEntry(
        ACCOUNTS_CACHE_KEY,
        accounts,
        ACCOUNTS_CACHE_TTL,
        cacheGenerationAfter,
      );
      const release = deployIdentity();
      return {
        ok: true,
        probeKind: PROBE_KIND,
        cacheGenerationBefore,
        cacheGenerationAfter,
        sourceObservedAt,
        sourceObservedRevision,
        financeTimeZone,
        deployIdentity: release?.contract ?? null,
      };
    }, { label: 'reconnect-freshness-probe' });
  }

  async function runProbe() {
    const coalesced = inFlight != null;
    if (!inFlight) {
      inFlight = performProbe().finally(() => {
        inFlight = null;
      });
    }
    const result = await inFlight;
    return { ...result, coalesced };
  }

  return {
    PROBE_KIND,
    ACCOUNTS_CACHE_KEY,
    deriveSourceObservedRevision,
    runProbe,
    getInFlight: () => inFlight,
  };
}

module.exports = {
  ACCOUNTS_CACHE_KEY,
  PROBE_KIND,
  createReconnectFreshnessProbeService,
  deriveSourceObservedRevision,
};

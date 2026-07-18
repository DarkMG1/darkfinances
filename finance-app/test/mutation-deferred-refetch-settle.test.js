/**
 * Deterministic deferred-refetch settle simulation for form/action/screen hooks.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  awaitMutationErrorReconciliation,
  startMutationErrorReconciliation,
} = require('../src/lib/mutation-error-reconciliation');
const {
  bumpMutationHookEpoch,
  captureMutationDispatchToken,
  invalidateMutationDispatch,
  isMutationDispatchTokenCurrent,
} = require('../src/lib/mutation-hook-identity');

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function createSettleSim(kind = 'boolean') {
  const epochRef = { value: 0 };
  const dispatchIdRef = { value: 0 };
  let locked = false;
  let refetchInFlight = false;
  let bDispatchedDuringARefetch = false;
  let staleAOverwroteB = false;
  let outcome = null;

  const captureToken = () => captureMutationDispatchToken(epochRef, dispatchIdRef, 'scope', 1, kind === 'screen' ? undefined : 'form');
  const isCurrent = (token) => isMutationDispatchTokenCurrent(token, epochRef, dispatchIdRef, 'scope', 1, kind === 'screen' ? undefined : 'form');

  const startDispatch = () => {
    if (locked) return null;
    locked = true;
    return captureToken();
  };

  const finishSettle = async (token, errorTask) => {
    await awaitMutationErrorReconciliation(errorTask);
    if (!isCurrent(token)) return { unlocked: false };
    locked = false;
    return { unlocked: true };
  };

  return {
    get locked() { return locked; },
    get refetchInFlight() { return refetchInFlight; },
    get bDispatchedDuringARefetch() { return bDispatchedDuringARefetch; },
    get staleAOverwroteB() { return staleAOverwroteB; },
    get outcome() { return outcome; },
    setOutcome(v) { outcome = v; },
    startDispatch,
    finishSettle,
    async runErrorRefetch(token, ms) {
      return startMutationErrorReconciliation(async () => {
        if (!isCurrent(token)) return;
        refetchInFlight = true;
        await delay(ms);
        refetchInFlight = false;
        if (!isCurrent(token)) return;
        outcome = { kind: 'conflict_stale', summary: 'stale' };
      });
    },
    tryDispatchB() {
      if (locked) {
        bDispatchedDuringARefetch = true;
        return null;
      }
      return startDispatch();
    },
    applyStaleAContinuation(tokenA) {
      if (!isCurrent(tokenA)) return;
      staleAOverwroteB = true;
      outcome = { kind: 'stale_overwrite', summary: 'bad' };
    },
    invalidateForB() {
      bumpMutationHookEpoch(epochRef);
      invalidateMutationDispatch(dispatchIdRef, epochRef);
      locked = false;
    },
  };
}

for (const kind of ['form', 'action', 'screen']) {
  test(`${kind}: lock held through deferred refetch; no B dispatch during A refetch`, async () => {
    const sim = createSettleSim(kind === 'screen' ? 'screen' : 'boolean');
    const tokenA = sim.startDispatch();
    assert.ok(tokenA);
    const errorTask = await sim.runErrorRefetch(tokenA, 30);
    assert.equal(sim.locked, true);
    assert.equal(sim.tryDispatchB(), null);
    assert.equal(sim.bDispatchedDuringARefetch, true);
    const settled = await sim.finishSettle(tokenA, errorTask);
    assert.equal(settled.unlocked, true);
    assert.equal(sim.locked, false);
  });

  test(`${kind}: stale A continuation cannot overwrite B after identity invalidation`, async () => {
    const sim = createSettleSim(kind === 'screen' ? 'screen' : 'boolean');
    const tokenA = sim.startDispatch();
    const errorTask = sim.runErrorRefetch(tokenA, 5);
    sim.invalidateForB();
    const tokenB = sim.startDispatch();
    assert.ok(tokenB);
    sim.setOutcome({ kind: 'fresh', summary: 'B' });
    await errorTask;
    sim.applyStaleAContinuation(tokenA);
    assert.equal(sim.staleAOverwroteB, false);
    assert.equal(sim.outcome.kind, 'fresh');
    await sim.finishSettle(tokenA, Promise.resolve());
    await sim.finishSettle(tokenB, Promise.resolve());
  });
}

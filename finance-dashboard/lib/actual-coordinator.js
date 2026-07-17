'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const { SerialQueue } = require('./serial-queue');

const MAX_NEST_DEPTH = 32;
const DEFAULT_DEADLOCK_MS = 30_000;
/** Max fill recomputes when generation bumps during cachedActual I/O. */
const MAX_STALE_FILL_ATTEMPTS = 4;
const laneStorage = new AsyncLocalStorage();

class ActualCoordinator {
  constructor(name = 'actual-api') {
    this.name = name;
    this.queue = new SerialQueue(name);
    this.generation = 0;
    this.boundCache = null;
    this.shutdownFinalized = false;
    this.stats = {
      readsStarted: 0,
      writesStarted: 0,
      recoveriesStarted: 0,
      shutdownsStarted: 0,
      invalidations: 0,
      staleFillsDiscarded: 0,
      staleFillRetries: 0,
      staleFillExhaustions: 0,
      cacheHits: 0,
      cacheMisses: 0,
      nestedBypasses: 0,
      rejectedAfterClose: 0,
    };
    this.recent = [];
  }

  bindCache(cache) {
    this.boundCache = cache;
  }

  _record(event) {
    this.recent.push({ at: Date.now(), ...event });
    if (this.recent.length > 64) this.recent.shift();
  }

  invalidateGeneration({ keys } = {}) {
    this.generation += 1;
    if (this.boundCache) {
      if (Array.isArray(keys) && keys.length > 0) {
        for (const key of keys) this.boundCache.del(key);
      } else {
        this.boundCache.flushAll();
      }
    }
    this.stats.invalidations += 1;
    this._record({
      kind: 'invalidate',
      generation: this.generation,
      keys: Array.isArray(keys) && keys.length > 0 ? keys : null,
    });
    return this.generation;
  }

  readCacheEntry(key) {
    if (!this.boundCache) return undefined;
    const entry = this.boundCache.get(key);
    if (!entry || entry.generation !== this.generation) return undefined;
    return entry.value;
  }

  publishCacheEntry(key, value, ttl, captureGeneration) {
    if (!this.boundCache) return false;
    if (captureGeneration !== this.generation) {
      this.stats.staleFillsDiscarded += 1;
      this._record({ kind: 'stale-fill', key, captureGeneration, generation: this.generation });
      return false;
    }
    this.boundCache.set(key, { generation: captureGeneration, value }, ttl);
    return true;
  }

  async _runHeld(kind, task, { invalidateBefore = false, label = kind } = {}) {
    if (this.shutdownFinalized) {
      this.stats.rejectedAfterClose += 1;
      throw new Error(`${this.name} shutdown is finalized`);
    }
    const activeLane = laneStorage.getStore();
    if (activeLane) {
      activeLane.depth += 1;
      if (activeLane.depth > MAX_NEST_DEPTH) {
        activeLane.depth -= 1;
        throw new Error(`${this.name} nested coordinator depth exceeded (${MAX_NEST_DEPTH})`);
      }
      this.stats.nestedBypasses += 1;
      this._record({ kind: 'nested', holdKind: kind, label, depth: activeLane.depth });
      try {
        return await task({ generation: this.generation, nested: true });
      } finally {
        activeLane.depth -= 1;
      }
    }

    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${this.name} coordinator wait timed out after ${DEFAULT_DEADLOCK_MS}ms (${label})`)),
        DEFAULT_DEADLOCK_MS,
      );
    });

    try {
      return await Promise.race([
        this.queue.run(() => laneStorage.run({ depth: 0, kind }, async () => {
          const captureGeneration = this.generation;
          try {
            if (invalidateBefore) this.invalidateGeneration();
            if (kind === 'read') this.stats.readsStarted += 1;
            if (kind === 'write') this.stats.writesStarted += 1;
            if (kind === 'recover') this.stats.recoveriesStarted += 1;
            this._record({ kind: 'enter', holdKind: kind, label, generation: this.generation });
            return await task({ generation: captureGeneration, nested: false });
          } finally {
            this._record({ kind: 'leave', holdKind: kind, label });
          }
        })),
        deadline,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  runRead(task, options = {}) {
    return this._runHeld('read', task, options);
  }

  runWrite(task, options = {}) {
    return this._runHeld('write', task, { ...options, invalidateBefore: options.invalidateBefore !== false });
  }

  runRecover(task, options = {}) {
    return this._runHeld('recover', task, { ...options, invalidateBefore: false });
  }

  cachedRead(key, fn, ttl = 300) {
    const hit = this.readCacheEntry(key);
    if (hit !== undefined) {
      this.stats.cacheHits += 1;
      return Promise.resolve(hit);
    }
    this.stats.cacheMisses += 1;
    return this.runRead(async () => {
      let rehit = this.readCacheEntry(key);
      if (rehit !== undefined) {
        this.stats.cacheHits += 1;
        return rehit;
      }
      for (let attempt = 1; attempt <= MAX_STALE_FILL_ATTEMPTS; attempt += 1) {
        const captureGeneration = this.generation;
        const value = await fn();
        if (this.publishCacheEntry(key, value, ttl, captureGeneration)) {
          return value;
        }
        this.stats.staleFillRetries += 1;
        rehit = this.readCacheEntry(key);
        if (rehit !== undefined) {
          this.stats.cacheHits += 1;
          return rehit;
        }
      }
      this.stats.staleFillExhaustions += 1;
      throw new Error(
        `${this.name} cache fill for "${key}" exhausted ${MAX_STALE_FILL_ATTEMPTS} stale-fill attempts`,
      );
    }, { label: `cache:${key}` });
  }

  stopAdmission() {
    if (!this.queue.closed) {
      this.queue.close();
      this._record({ kind: 'stop-admission' });
    }
  }

  async shutdownHandoff(task, { drainTimeoutMs = 10_000 } = {}) {
    if (this.shutdownFinalized) {
      throw new Error(`${this.name} shutdown already finalized`);
    }
    this.stopAdmission();
    await this.drain(drainTimeoutMs);
    this.stats.shutdownsStarted += 1;
    return laneStorage.run({ depth: 0, kind: 'shutdown' }, async () => {
      this._record({ kind: 'enter', holdKind: 'shutdown', label: 'shutdownHandoff' });
      try {
        return await task();
      } finally {
        this.shutdownFinalized = true;
        this._record({ kind: 'leave', holdKind: 'shutdown', label: 'shutdownHandoff' });
      }
    });
  }

  get size() {
    return this.queue.size;
  }

  close() {
    this.stopAdmission();
  }

  drain(timeoutMs) {
    return this.queue.drain(timeoutMs);
  }

  getHealth() {
    const activeLane = laneStorage.getStore();
    return {
      name: this.name,
      generation: this.generation,
      queued: this.queue.size,
      holdDepth: activeLane ? activeLane.depth : 0,
      holdKind: activeLane ? activeLane.kind : null,
      closed: this.queue.closed,
      shutdownFinalized: this.shutdownFinalized,
      stats: { ...this.stats },
      recent: this.recent.slice(-16),
    };
  }
}

let defaultCoordinator = new ActualCoordinator();

function getActualCoordinator() {
  return defaultCoordinator;
}

function setActualCoordinator(next) {
  defaultCoordinator = next;
}

function resetActualCoordinator(name = 'actual-api') {
  defaultCoordinator = new ActualCoordinator(name);
  return defaultCoordinator;
}

module.exports = {
  ActualCoordinator,
  getActualCoordinator,
  setActualCoordinator,
  resetActualCoordinator,
  MAX_NEST_DEPTH,
  MAX_STALE_FILL_ATTEMPTS,
};

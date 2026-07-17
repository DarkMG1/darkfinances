class SerialQueue {
  constructor(name = 'queue', { maxPending = 0 } = {}) {
    this.name = name;
    this.maxPending = Number.isInteger(maxPending) && maxPending > 0 ? maxPending : 0;
    this.pending = 0;
    this.tail = Promise.resolve();
    this.closed = false;
    this.rejectedOverCapacity = 0;
  }

  run(task) {
    if (typeof task !== 'function') throw new TypeError('SerialQueue task must be a function');
    if (this.closed) return Promise.reject(new Error(`${this.name} is closed`));
    if (this.maxPending > 0 && this.pending >= this.maxPending) {
      this.rejectedOverCapacity += 1;
      return Promise.reject(new Error(`${this.name} pending capacity exceeded (${this.maxPending})`));
    }
    this.pending += 1;
    const execute = () => Promise.resolve().then(task);
    const result = this.tail.then(execute, execute);
    this.tail = result
      .catch(() => {})
      .finally(() => {
        this.pending = Math.max(0, this.pending - 1);
      });
    return result;
  }

  get size() {
    return this.pending;
  }

  close() {
    this.closed = true;
  }

  async drain(timeoutMs = 10_000) {
    let timer;
    try {
      await Promise.race([
        this.tail,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${this.name} did not drain within ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

module.exports = { SerialQueue };

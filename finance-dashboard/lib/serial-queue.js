class SerialQueue {
  constructor(name = 'queue') {
    this.name = name;
    this.pending = 0;
    this.tail = Promise.resolve();
  }

  run(task) {
    if (typeof task !== 'function') throw new TypeError('SerialQueue task must be a function');
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
}

module.exports = { SerialQueue };

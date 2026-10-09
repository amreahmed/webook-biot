class LoginControl {
  constructor() {
    this.paused = new Set();
    this.active = new Map();
    this.stopping = new Map();
  }

  isPaused(owner) {
    return this.paused.has(String(owner));
  }

  resume(owner) {
    const key = String(owner);
    if (this.stopping.has(key)) throw new Error("Account login is still stopping. Try again shortly.");
    this.paused.delete(key);
  }

  async run(owner, work) {
    const key = String(owner);
    if (this.isPaused(key)) throw new Error("Account login was stopped. Use Link Accounts or Re-link to resume.");
    const controller = new AbortController();
    let finish;
    const operation = { controller, done: new Promise((resolve) => { finish = resolve; }) };
    const operations = this.active.get(key) || new Set();
    operations.add(operation);
    this.active.set(key, operations);
    try {
      return await work(controller.signal);
    } finally {
      operations.delete(operation);
      if (!operations.size) this.active.delete(key);
      finish();
    }
  }

  stop(owner, cleanup) {
    const key = String(owner);
    if (this.stopping.has(key)) return this.stopping.get(key);
    this.paused.add(key);
    const operations = [...(this.active.get(key) || [])];
    for (const { controller } of operations) controller.abort();
    const promise = (async () => {
      await Promise.all(operations.map(({ done }) => done));
      return cleanup();
    })().finally(() => this.stopping.delete(key));
    this.stopping.set(key, promise);
    return promise;
  }
}

module.exports = { LoginControl };

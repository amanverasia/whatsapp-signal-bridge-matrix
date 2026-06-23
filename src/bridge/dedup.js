export class DedupStore {
  constructor(ttlMin = 5) {
    this.ttlMs = ttlMin * 60 * 1000;
    this.entries = new Map();
    this.sweepInterval = setInterval(() => this.sweep(), 60 * 1000);
    if (this.sweepInterval.unref) this.sweepInterval.unref();
  }

  has(key) {
    const ts = this.entries.get(key);
    if (!ts) return false;
    if (Date.now() - ts > this.ttlMs) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  add(key) {
    this.entries.set(key, Date.now());
  }

  sweep() {
    const now = Date.now();
    for (const [key, ts] of this.entries) {
      if (now - ts > this.ttlMs) this.entries.delete(key);
    }
  }

  stop() {
    clearInterval(this.sweepInterval);
  }
}

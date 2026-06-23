export class IdMap {
  constructor(ttlMin = 60) {
    this.ttlMs = ttlMin * 60 * 1000;
    this.entries = new Map();
    this.sweepInterval = setInterval(() => this.sweep(), 5 * 60 * 1000);
    if (this.sweepInterval.unref) this.sweepInterval.unref();
  }

  _key(platform, id) {
    return `${platform}:${id}`;
  }

  set(srcPlatform, srcId, dstPlatform, dstId) {
    const now = Date.now();
    this.entries.set(this._key(srcPlatform, srcId), { dstPlatform, dstId, timestamp: now });
    this.entries.set(this._key(dstPlatform, dstId), { dstPlatform: srcPlatform, dstId: srcId, timestamp: now });
  }

  lookup(srcPlatform, srcId) {
    const key = this._key(srcPlatform, srcId);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return { dstPlatform: entry.dstPlatform, dstId: entry.dstId };
  }

  remove(srcPlatform, srcId) {
    const entry = this.entries.get(this._key(srcPlatform, srcId));
    if (!entry) return;
    this.entries.delete(this._key(srcPlatform, srcId));
    this.entries.delete(this._key(entry.dstPlatform, entry.dstId));
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.timestamp > this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }

  stop() {
    clearInterval(this.sweepInterval);
  }
}

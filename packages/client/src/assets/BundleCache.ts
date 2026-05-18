// Persistent content-addressed cache for bundled asset blobs.
// IndexedDB-backed in production; the test suite swaps in an in-memory
// driver so CI doesn't need a real browser DB.
//
// Lifecycle:
//   - Host upload / load-from-zip → put({ pinned: true })  — authored content,
//     never evicted.
//   - Peer fetched-on-demand     → put({ pinned: false }) — eligible for LRU
//     eviction once the cap is exceeded.
//   - AssetService reads          → get(hash) + touch(hash) to keep hot.
//
// Quota errors from the driver are swallowed (logged via the optional
// logger) so the host UI never crashes when storage is full — the blob
// simply isn't persisted, and the in-memory BundleStore continues to serve
// it for the current session.

const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;  // 500 MB

export interface BundleCacheRecord {
  hash:         string;
  blob:         Blob;
  size:         number;
  lastAccessed: number;
  pinned:       boolean;
}

// The minimum surface the cache needs from its persistence layer. The
// in-memory test driver and the real IDB driver both satisfy this.
export interface BundleCacheDriver {
  get(hash: string):                              Promise<BundleCacheRecord | undefined>;
  put(record: BundleCacheRecord):                 Promise<void>;
  delete(hash: string):                           Promise<void>;
  list(opts?: { pinned?: boolean }):              Promise<BundleCacheRecord[]>;
}

export interface BundleCacheOptions {
  driver:    BundleCacheDriver;
  maxBytes?: number;
  // Called on swallowed errors (most commonly QuotaExceededError on put).
  // Defaults to a noop — host UI doesn't surface storage failures.
  logger?:   (message: string, err: unknown) => void;
  // Injectable clock so tests can deterministically assert lastAccessed
  // ordering. Production omits this and falls back to Date.now.
  now?:      () => number;
}

export class BundleCache {
  private readonly driver:   BundleCacheDriver;
  private readonly maxBytes: number;
  private readonly logger:   (message: string, err: unknown) => void;
  private readonly now:      () => number;

  constructor(opts: BundleCacheOptions) {
    this.driver   = opts.driver;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.logger   = opts.logger   ?? (() => {});
    this.now      = opts.now      ?? (() => Date.now());
  }

  async get(hash: string): Promise<Blob | undefined> {
    const rec = await this.driver.get(hash);
    return rec?.blob;
  }

  async put(hash: string, blob: Blob, opts: { pinned?: boolean } = {}): Promise<void> {
    const record: BundleCacheRecord = {
      hash,
      blob,
      size:         blob.size,
      lastAccessed: this.now(),
      pinned:       opts.pinned ?? false,
    };
    try {
      await this.driver.put(record);
    } catch (err) {
      // Quota / disk full / transient IDB error — surfaced as a no-op put
      // so callers don't need to wrap every persistence step in try/catch.
      this.logger(`BundleCache.put failed for ${hash}`, err);
    }
  }

  async touch(hash: string): Promise<void> {
    const rec = await this.driver.get(hash);
    if (!rec) return;
    rec.lastAccessed = this.now();
    try {
      await this.driver.put(rec);
    } catch (err) {
      this.logger(`BundleCache.touch failed for ${hash}`, err);
    }
  }

  async delete(hash: string): Promise<boolean> {
    const rec = await this.driver.get(hash);
    if (!rec) return false;
    await this.driver.delete(hash);
    return true;
  }

  async list(opts: { pinned?: boolean } = {}): Promise<BundleCacheRecord[]> {
    return this.driver.list(opts);
  }

  // Drops least-recently-used unpinned entries until total stored size ≤ cap.
  // Pinned entries are never evicted even if they alone exceed the cap.
  async evictToCap(cap = this.maxBytes): Promise<void> {
    const all = await this.driver.list();
    let total = 0;
    for (const r of all) total += r.size;
    if (total <= cap) return;
    const candidates = all
      .filter(r => !r.pinned)
      .sort((a, b) => a.lastAccessed - b.lastAccessed);
    for (const r of candidates) {
      if (total <= cap) break;
      await this.driver.delete(r.hash);
      total -= r.size;
    }
  }
}

import { describe, test, expect, vi } from 'vitest';
import { BundleCache, type BundleCacheDriver, type BundleCacheRecord } from './BundleCache';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

// Minimal in-memory driver used as a test double for IndexedDB. Records
// stay in a Map keyed by hash; list filters by pinned. The optional
// `failPut` flag lets a test simulate a quota error.
function makeDriver(): BundleCacheDriver & {
  records:  Map<string, BundleCacheRecord>;
  failPut:  { value: Error | null };
} {
  const records = new Map<string, BundleCacheRecord>();
  const failPut = { value: null as Error | null };
  return {
    records,
    failPut,
    async get(hash) {
      const r = records.get(hash);
      return r ? { ...r } : undefined;
    },
    async put(record) {
      if (failPut.value) throw failPut.value;
      records.set(record.hash, { ...record });
    },
    async delete(hash) {
      records.delete(hash);
    },
    async list(opts) {
      const all = [...records.values()].map(r => ({ ...r }));
      if (opts?.pinned === undefined) return all;
      return all.filter(r => r.pinned === opts.pinned);
    },
  };
}

// Deterministic clock so lastAccessed comparisons don't race.
function makeClock(start = 1_000): () => number {
  let t = start;
  return () => ++t;
}

async function bytesOf(blob: Blob): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

describe('BundleCache.put / get', () => {
  test('put then get round-trips a blob byte-for-byte', async () => {
    const driver = makeDriver();
    const cache  = new BundleCache({ driver, now: makeClock() });
    const blob   = new Blob([new Uint8Array([0xCA, 0xFE, 0xBA, 0xBE])]);
    await cache.put(HASH_A, blob);
    const got = await cache.get(HASH_A);
    expect(got).toBeDefined();
    expect(await bytesOf(got!)).toEqual([0xCA, 0xFE, 0xBA, 0xBE]);
  });

  test('get returns undefined for unknown hash', async () => {
    const cache = new BundleCache({ driver: makeDriver(), now: makeClock() });
    expect(await cache.get(HASH_A)).toBeUndefined();
  });

  test('put({ pinned: true }) stores the entry as pinned', async () => {
    const driver = makeDriver();
    const cache  = new BundleCache({ driver, now: makeClock() });
    await cache.put(HASH_A, new Blob(['x']), { pinned: true });
    expect(driver.records.get(HASH_A)?.pinned).toBe(true);
  });

  test('put defaults pinned to false', async () => {
    const driver = makeDriver();
    const cache  = new BundleCache({ driver, now: makeClock() });
    await cache.put(HASH_A, new Blob(['x']));
    expect(driver.records.get(HASH_A)?.pinned).toBe(false);
  });
});

describe('BundleCache.touch', () => {
  test('updates lastAccessed visible via list()', async () => {
    const driver = makeDriver();
    const now    = makeClock(100);
    const cache  = new BundleCache({ driver, now });
    await cache.put(HASH_A, new Blob(['x']));
    const before = driver.records.get(HASH_A)!.lastAccessed;
    await cache.touch(HASH_A);
    const after  = driver.records.get(HASH_A)!.lastAccessed;
    expect(after).toBeGreaterThan(before);
  });

  test('is a no-op for unknown hash', async () => {
    const driver = makeDriver();
    const cache  = new BundleCache({ driver, now: makeClock() });
    await cache.touch(HASH_A);
    expect(driver.records.size).toBe(0);
  });
});

describe('BundleCache.evictToCap', () => {
  test('drops least-recently-used unpinned entries until total ≤ cap', async () => {
    const driver = makeDriver();
    const now    = makeClock();
    const cache  = new BundleCache({ driver, now });
    // Three 100-byte unpinned blobs at increasing lastAccessed times.
    await cache.put(HASH_A, new Blob([new Uint8Array(100)])); // oldest
    await cache.put(HASH_B, new Blob([new Uint8Array(100)]));
    await cache.put(HASH_C, new Blob([new Uint8Array(100)])); // newest
    await cache.evictToCap(150);
    // After eviction only the most recent should remain (size 100 ≤ 150).
    expect(driver.records.has(HASH_A)).toBe(false);
    expect(driver.records.has(HASH_B)).toBe(false);
    expect(driver.records.has(HASH_C)).toBe(true);
  });

  test('pinned entries are never evicted, even when total exceeds cap', async () => {
    const driver = makeDriver();
    const now    = makeClock();
    const cache  = new BundleCache({ driver, now });
    await cache.put(HASH_A, new Blob([new Uint8Array(100)]), { pinned: true });
    await cache.put(HASH_B, new Blob([new Uint8Array(100)]), { pinned: true });
    await cache.put(HASH_C, new Blob([new Uint8Array(100)])); // unpinned
    await cache.evictToCap(50);
    expect(driver.records.has(HASH_A)).toBe(true);
    expect(driver.records.has(HASH_B)).toBe(true);
    expect(driver.records.has(HASH_C)).toBe(false);
  });

  test('respects lastAccessed order via touch — touched entries survive', async () => {
    const driver = makeDriver();
    const now    = makeClock();
    const cache  = new BundleCache({ driver, now });
    await cache.put(HASH_A, new Blob([new Uint8Array(100)]));
    await cache.put(HASH_B, new Blob([new Uint8Array(100)]));
    await cache.put(HASH_C, new Blob([new Uint8Array(100)]));
    await cache.put(HASH_D, new Blob([new Uint8Array(100)]));
    await cache.touch(HASH_A); // promote oldest to newest
    await cache.evictToCap(200);
    expect(driver.records.has(HASH_A)).toBe(true);
    expect(driver.records.has(HASH_D)).toBe(true);
    // B and C were the two oldest after the touch.
    expect(driver.records.has(HASH_B)).toBe(false);
    expect(driver.records.has(HASH_C)).toBe(false);
  });

  test('default cap from constructor is used when called without args', async () => {
    const driver = makeDriver();
    const cache  = new BundleCache({ driver, maxBytes: 150, now: makeClock() });
    await cache.put(HASH_A, new Blob([new Uint8Array(100)]));
    await cache.put(HASH_B, new Blob([new Uint8Array(100)]));
    await cache.evictToCap();
    expect(driver.records.size).toBe(1);
  });
});

describe('BundleCache.list', () => {
  test('list() returns all entries', async () => {
    const driver = makeDriver();
    const cache  = new BundleCache({ driver, now: makeClock() });
    await cache.put(HASH_A, new Blob(['a']), { pinned: true });
    await cache.put(HASH_B, new Blob(['b']));
    const all = await cache.list();
    expect(all.map(r => r.hash).sort()).toEqual([HASH_A, HASH_B].sort());
  });

  test('list({ pinned: true }) returns only host-authored entries', async () => {
    const driver = makeDriver();
    const cache  = new BundleCache({ driver, now: makeClock() });
    await cache.put(HASH_A, new Blob(['a']), { pinned: true });
    await cache.put(HASH_B, new Blob(['b']));
    await cache.put(HASH_C, new Blob(['c']), { pinned: true });
    const pinned = await cache.list({ pinned: true });
    expect(pinned.map(r => r.hash).sort()).toEqual([HASH_A, HASH_C].sort());
  });

  test('list({ pinned: false }) returns only unpinned entries', async () => {
    const driver = makeDriver();
    const cache  = new BundleCache({ driver, now: makeClock() });
    await cache.put(HASH_A, new Blob(['a']), { pinned: true });
    await cache.put(HASH_B, new Blob(['b']));
    const unpinned = await cache.list({ pinned: false });
    expect(unpinned.map(r => r.hash)).toEqual([HASH_B]);
  });
});

describe('BundleCache quota handling', () => {
  test('put error is swallowed and logged; subsequent get returns undefined', async () => {
    const driver  = makeDriver();
    const logger  = vi.fn();
    const cache   = new BundleCache({ driver, logger, now: makeClock() });
    driver.failPut.value = new Error('QuotaExceededError');
    await expect(cache.put(HASH_A, new Blob(['x']))).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledTimes(1);
    expect(await cache.get(HASH_A)).toBeUndefined();
  });

  test('touch errors are swallowed too', async () => {
    const driver = makeDriver();
    const logger = vi.fn();
    const cache  = new BundleCache({ driver, logger, now: makeClock() });
    await cache.put(HASH_A, new Blob(['x']));
    driver.failPut.value = new Error('boom');
    await expect(cache.touch(HASH_A)).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledTimes(1);
  });
});

describe('BundleCache.delete', () => {
  test('delete removes the entry and reports whether it existed', async () => {
    const driver = makeDriver();
    const cache  = new BundleCache({ driver, now: makeClock() });
    await cache.put(HASH_A, new Blob(['x']));
    expect(await cache.delete(HASH_A)).toBe(true);
    expect(await cache.get(HASH_A)).toBeUndefined();
    expect(await cache.delete(HASH_A)).toBe(false);
  });
});

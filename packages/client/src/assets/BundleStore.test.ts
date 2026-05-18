import { describe, test, expect, vi } from 'vitest';
import { BundleStore } from './BundleStore';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe('BundleStore', () => {
  test('put then get round-trips byte-for-byte', async () => {
    const store = new BundleStore();
    const blob  = new Blob([new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF])]);
    store.put(HASH_A, blob);
    const got = store.get(HASH_A);
    expect(got).toBeDefined();
    expect(Array.from(await bytesOf(got!))).toEqual([0xDE, 0xAD, 0xBE, 0xEF]);
  });

  test('has reflects presence', () => {
    const store = new BundleStore();
    expect(store.has(HASH_A)).toBe(false);
    store.put(HASH_A, new Blob(['x']));
    expect(store.has(HASH_A)).toBe(true);
  });

  test('two puts with same hash store one entry (dedup)', () => {
    const store = new BundleStore();
    store.put(HASH_A, new Blob(['first']));
    store.put(HASH_A, new Blob(['second']));
    expect(store.list().length).toBe(1);
  });

  test('delete removes; subsequent get returns undefined', () => {
    const store = new BundleStore();
    store.put(HASH_A, new Blob(['x']));
    expect(store.delete(HASH_A)).toBe(true);
    expect(store.get(HASH_A)).toBeUndefined();
    expect(store.has(HASH_A)).toBe(false);
  });

  test('delete on unknown hash returns false', () => {
    const store = new BundleStore();
    expect(store.delete(HASH_A)).toBe(false);
  });

  test('size reflects total bytes across all stored blobs', () => {
    const store = new BundleStore();
    store.put(HASH_A, new Blob([new Uint8Array(100)]));
    store.put(HASH_B, new Blob([new Uint8Array(50)]));
    expect(store.size()).toBe(150);
  });

  test('list returns all stored hashes', () => {
    const store = new BundleStore();
    store.put(HASH_A, new Blob(['a']));
    store.put(HASH_B, new Blob(['b']));
    expect(store.list().sort()).toEqual([HASH_A, HASH_B].sort());
  });

  test('onPut hook fires on new put, not on dedup put', () => {
    const onPut = vi.fn();
    const store = new BundleStore({ onPut });
    const blob1 = new Blob(['first']);
    const blob2 = new Blob(['second']);
    store.put(HASH_A, blob1);
    store.put(HASH_A, blob2);
    expect(onPut).toHaveBeenCalledTimes(1);
    expect(onPut).toHaveBeenCalledWith(HASH_A, blob1);
  });

  test('onDelete hook fires on actual delete, not on missing-hash delete', () => {
    const onDelete = vi.fn();
    const store = new BundleStore({ onDelete });
    store.put(HASH_A, new Blob(['x']));
    store.delete(HASH_A);
    store.delete(HASH_A); // already gone
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(HASH_A);
  });
});

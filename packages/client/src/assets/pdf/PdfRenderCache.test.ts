import { describe, test, expect, vi } from 'vitest';
import * as THREE from 'three';
import { PdfRenderCache } from './PdfRenderCache';

// Plain stand-in for THREE.CanvasTexture — the cache only ever calls
// `.dispose()`, so we don't need a real canvas / WebGL context.
function fakeTexture(label: string): THREE.CanvasTexture {
  const t = { label, dispose: vi.fn() };
  return t as unknown as THREE.CanvasTexture;
}

describe('PdfRenderCache', () => {
  test('get returns the same instance on hit; undefined on miss', () => {
    const cache = new PdfRenderCache();
    const tex   = fakeTexture('a');
    cache.put('custom:foo', 1, 2, tex);
    expect(cache.get('custom:foo', 1, 2)).toBe(tex);
    expect(cache.get('custom:foo', 2, 2)).toBeUndefined();
    expect(cache.get('custom:bar', 1, 2)).toBeUndefined();
  });

  test('evicts the oldest entry for a slug once the cap is exceeded', () => {
    const cache = new PdfRenderCache({ capacityPerSlug: 3 });
    const t1 = fakeTexture('1'), t2 = fakeTexture('2'),
          t3 = fakeTexture('3'), t4 = fakeTexture('4');
    cache.put('custom:foo', 1, 1, t1);
    cache.put('custom:foo', 2, 1, t2);
    cache.put('custom:foo', 3, 1, t3);
    cache.put('custom:foo', 4, 1, t4);
    // t1 was the oldest → evicted and disposed
    expect(cache.get('custom:foo', 1, 1)).toBeUndefined();
    expect((t1 as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose).toHaveBeenCalled();
    expect(cache.get('custom:foo', 4, 1)).toBe(t4);
    expect(cache.size('custom:foo')).toBe(3);
  });

  test('get bumps recency — recently-read entries survive eviction', () => {
    const cache = new PdfRenderCache({ capacityPerSlug: 3 });
    const t1 = fakeTexture('1'), t2 = fakeTexture('2'),
          t3 = fakeTexture('3'), t4 = fakeTexture('4');
    cache.put('custom:foo', 1, 1, t1);
    cache.put('custom:foo', 2, 1, t2);
    cache.put('custom:foo', 3, 1, t3);
    // Touch t1 → t2 becomes the oldest.
    expect(cache.get('custom:foo', 1, 1)).toBe(t1);
    cache.put('custom:foo', 4, 1, t4);
    expect(cache.get('custom:foo', 2, 1)).toBeUndefined();
    expect(cache.get('custom:foo', 1, 1)).toBe(t1);
  });

  test('slug isolation: filling slug-A does not evict slug-B', () => {
    const cache = new PdfRenderCache({ capacityPerSlug: 3 });
    const b = fakeTexture('b');
    cache.put('custom:b', 1, 1, b);
    for (let i = 1; i <= 5; i++) cache.put('custom:a', i, 1, fakeTexture(`a${i}`));
    expect(cache.get('custom:b', 1, 1)).toBe(b);
    expect(cache.size('custom:b')).toBe(1);
    expect(cache.size('custom:a')).toBe(3);
  });

  test('put with the same (page, scale) replaces and re-inserts', () => {
    const cache = new PdfRenderCache({ capacityPerSlug: 3 });
    const old = fakeTexture('old');
    const repl = fakeTexture('repl');
    cache.put('custom:foo', 1, 1, old);
    cache.put('custom:foo', 1, 1, repl);
    expect(cache.get('custom:foo', 1, 1)).toBe(repl);
  });

  test('evict(slug) disposes every texture for that slug', () => {
    const cache = new PdfRenderCache({ capacityPerSlug: 3 });
    const t1 = fakeTexture('1'), t2 = fakeTexture('2');
    cache.put('custom:foo', 1, 1, t1);
    cache.put('custom:foo', 2, 1, t2);
    cache.evict('custom:foo');
    expect((t1 as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose).toHaveBeenCalled();
    expect((t2 as unknown as { dispose: ReturnType<typeof vi.fn> }).dispose).toHaveBeenCalled();
    expect(cache.get('custom:foo', 1, 1)).toBeUndefined();
    expect(cache.size('custom:foo')).toBe(0);
  });

  test('different scales for the same page are distinct entries', () => {
    const cache = new PdfRenderCache({ capacityPerSlug: 3 });
    const lo = fakeTexture('lo');
    const hi = fakeTexture('hi');
    cache.put('custom:foo', 1, 1, lo);
    cache.put('custom:foo', 1, 2, hi);
    expect(cache.get('custom:foo', 1, 1)).toBe(lo);
    expect(cache.get('custom:foo', 1, 2)).toBe(hi);
  });
});

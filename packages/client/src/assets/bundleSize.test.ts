import { describe, test, expect } from 'vitest';
import { Manifest, type AssetEntry } from './Manifest';
import { bundleSizeOf, formatBytes, SINGLE_ASSET_WARN_BYTES, TOTAL_WARN_BYTES } from './bundleSize';

const HASH = 'a'.repeat(64);
const HASH2 = 'b'.repeat(64);

const urlEntry: AssetEntry = {
  slug: 'custom:url', name: 'U', type: 'image', url: 'http://x/u.png', preload: false,
};

const bundled = (slug: string, hash: string, size: number): AssetEntry => ({
  slug, name: slug, type: 'image', url: '', preload: false,
  bundled: true, hash, size,
});

describe('bundleSizeOf', () => {
  test('empty manifest → zero count and bytes', () => {
    expect(bundleSizeOf(Manifest.empty())).toEqual({ count: 0, bytes: 0 });
  });

  test('counts only bundled entries; URL-only entries are ignored', () => {
    const m = Manifest.from([
      urlEntry,
      bundled('custom:a', HASH, 1024),
      bundled('custom:b', HASH2, 2048),
    ]);
    expect(bundleSizeOf(m)).toEqual({ count: 2, bytes: 3072 });
  });

});

describe('formatBytes', () => {
  test.each([
    [0,             '0 B'],
    [512,           '512 B'],
    [1024,          '1 KB'],
    [2048,          '2 KB'],
    [1024 * 1024,   '1.0 MB'],
    [51 * 1024 * 1024, '51.0 MB'],
    [1024 * 1024 * 1024, '1.00 GB'],
  ])('formats %i as %s', (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });

  test('handles invalid input gracefully', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(NaN)).toBe('—');
  });
});

describe('thresholds', () => {
  test('SINGLE_ASSET_WARN_BYTES = 50 MB', () => {
    expect(SINGLE_ASSET_WARN_BYTES).toBe(50 * 1024 * 1024);
  });

  test('TOTAL_WARN_BYTES = 500 MB', () => {
    expect(TOTAL_WARN_BYTES).toBe(500 * 1024 * 1024);
  });
});

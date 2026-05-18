import { describe, test, expect, vi } from 'vitest';
import { BundleStore } from './BundleStore';
import { BundleCache, type BundleCacheDriver, type BundleCacheRecord } from './BundleCache';
import { Manifest } from './Manifest';
import {
  bundleBlob,
  entryFromUpload,
  fileStemForName,
  fileStemForSlug,
  inferAssetTypeFromFile,
  uniqueCustomSlug,
} from './bundleUpload';

function makeFakeDriver(): BundleCacheDriver {
  const records = new Map<string, BundleCacheRecord>();
  return {
    async get(hash) { return records.get(hash); },
    async put(rec)  { records.set(rec.hash, rec); },
    async delete(hash) { records.delete(hash); },
    async list(opts) {
      const all = [...records.values()];
      return opts?.pinned === undefined ? all : all.filter(r => r.pinned === opts.pinned);
    },
  };
}

const makeFile = (name: string, type: string, bytes = [1, 2, 3]): File =>
  new File([new Uint8Array(bytes)], name, { type });

describe('inferAssetTypeFromFile', () => {
  test('uses MIME type when available', () => {
    expect(inferAssetTypeFromFile(makeFile('x.bin', 'image/png'))).toBe('image');
    expect(inferAssetTypeFromFile(makeFile('x.bin', 'audio/mpeg'))).toBe('sound');
    expect(inferAssetTypeFromFile(makeFile('x.bin', 'model/gltf-binary'))).toBe('model');
  });

  test('falls back to extension when MIME is missing', () => {
    expect(inferAssetTypeFromFile(makeFile('x.PNG', ''))).toBe('image');
    expect(inferAssetTypeFromFile(makeFile('foo.glb', ''))).toBe('model');
    expect(inferAssetTypeFromFile(makeFile('foo.OGG', ''))).toBe('sound');
  });

  test('unknown extension + MIME → null', () => {
    expect(inferAssetTypeFromFile(makeFile('foo.xyz', ''))).toBeNull();
  });
});

describe('fileStemForSlug / fileStemForName', () => {
  test('strips extension', () => {
    expect(fileStemForSlug('photo.png')).toBe('photo');
    expect(fileStemForSlug('archive.tar.gz')).toBe('archive.tar');
  });

  test('strips parent path', () => {
    expect(fileStemForSlug('foo/bar/baz.glb')).toBe('baz');
  });

  test('fileStemForName replaces separators with spaces', () => {
    expect(fileStemForName('cool-card_01.png')).toBe('cool card 01');
  });
});

describe('uniqueCustomSlug', () => {
  test('returns suggestion when free', () => {
    expect(uniqueCustomSlug('photo', Manifest.empty())).toBe('custom:photo');
  });

  test('appends a counter when the slug is taken', () => {
    const m = Manifest.from([
      { slug: 'custom:photo',   name: 'P',  type: 'image', url: 'http://x/a.png', preload: false },
      { slug: 'custom:photo-2', name: 'P2', type: 'image', url: 'http://x/b.png', preload: false },
    ]);
    expect(uniqueCustomSlug('photo', m)).toBe('custom:photo-3');
  });

  test('sanitises inputs with invalid characters', () => {
    expect(uniqueCustomSlug('My Photo!', Manifest.empty())).toBe('custom:my-photo');
  });

  test('falls back to a default when the suggestion is empty after sanitising', () => {
    expect(uniqueCustomSlug('!!!', Manifest.empty())).toBe('custom:asset');
  });

  test('strips leading digits / separators so the slug body starts with a letter', () => {
    expect(uniqueCustomSlug('123foo', Manifest.empty())).toBe('custom:foo');
  });
});

describe('bundleBlob', () => {
  test('hashes, stores, and pins on first call', async () => {
    const store = new BundleStore();
    const cache = new BundleCache({ driver: makeFakeDriver() });
    const blob  = new Blob([new Uint8Array([1, 2, 3, 4])]);
    const hash  = await bundleBlob(blob, store, cache);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(store.has(hash)).toBe(true);
    const cached = await cache.list({ pinned: true });
    expect(cached.map(r => r.hash)).toEqual([hash]);
  });

  test('second call with identical bytes dedupes — single BundleStore entry', async () => {
    const store = new BundleStore();
    const cache = new BundleCache({ driver: makeFakeDriver() });
    const blob  = new Blob([new Uint8Array([1, 2, 3])]);
    const hashA = await bundleBlob(blob, store, cache);
    const hashB = await bundleBlob(blob, store, cache);
    expect(hashA).toBe(hashB);
    expect(store.list().length).toBe(1);
  });

  test('does not re-write to cache when bundle store already has the hash', async () => {
    const store = new BundleStore();
    const driver = makeFakeDriver();
    const putSpy = vi.spyOn(driver, 'put');
    const cache  = new BundleCache({ driver });
    const blob   = new Blob([new Uint8Array([7, 7, 7])]);
    await bundleBlob(blob, store, cache);
    await bundleBlob(blob, store, cache);
    expect(putSpy).toHaveBeenCalledTimes(1);
  });
});

describe('entryFromUpload', () => {
  test('produces a bundled AssetEntry with empty url breadcrumb', () => {
    const entry = entryFromUpload({
      slug: 'custom:foo', name: 'Foo', type: 'image',
      hash: 'a'.repeat(64), preload: true,
    });
    expect(entry).toEqual({
      slug: 'custom:foo', name: 'Foo', type: 'image',
      url: '', preload: true, bundled: true, hash: 'a'.repeat(64),
    });
  });
});

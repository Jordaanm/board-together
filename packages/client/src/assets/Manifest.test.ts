import { describe, test, expect } from 'vitest';
import {
  Manifest,
  ManifestError,
  validateSlug,
  isSlug,
  namespaceOf,
  type AssetEntry,
} from './Manifest';

const sampleImage: AssetEntry = {
  slug:    'custom:my-card',
  name:    'My card',
  type:    'image',
  url:     'http://example.com/c.png',
  preload: true,
};

const sampleSound: AssetEntry = {
  slug:    'custom:my-sound',
  name:    'My sound',
  type:    'sound',
  url:     'http://example.com/s.mp3',
  preload: false,
};

describe('validateSlug', () => {
  test('accepts canonical namespaced slugs', () => {
    expect(validateSlug('custom:my-card').ok).toBe(true);
    expect(validateSlug('base:placeholder/image').ok).toBe(true);
    expect(validateSlug('prim:cube').ok).toBe(true);
  });

  test('rejects empty / non-string slugs', () => {
    expect(validateSlug('').ok).toBe(false);
    expect(validateSlug(undefined as unknown as string).ok).toBe(false);
    expect(validateSlug(42 as unknown as string).ok).toBe(false);
  });

  test('rejects unknown namespaces', () => {
    const r = validateSlug('weird:thing');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/namespace/);
  });

  test('rejects slugs missing the namespace separator', () => {
    expect(validateSlug('nocolon').ok).toBe(false);
  });

  test('rejects bad slug body characters', () => {
    expect(validateSlug('custom:Bad Body').ok).toBe(false);
    expect(validateSlug('custom:UPPER').ok).toBe(false);
  });

  test('expectedNamespace constraint rejects mismatches', () => {
    const r = validateSlug('custom:x', 'base');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/expected namespace "base"/);
  });
});

describe('isSlug + namespaceOf', () => {
  test('isSlug only matches known namespaces', () => {
    expect(isSlug('custom:foo')).toBe(true);
    expect(isSlug('base:foo')).toBe(true);
    expect(isSlug('prim:foo')).toBe(true);
    expect(isSlug('http://example.com')).toBe(false);
    expect(isSlug('data:image/png;base64,...')).toBe(false);
    expect(isSlug('plain-string')).toBe(false);
  });

  test('namespaceOf returns the namespace or null', () => {
    expect(namespaceOf('custom:foo')).toBe('custom');
    expect(namespaceOf('http://x')).toBe(null);
  });
});

describe('Manifest construction', () => {
  test('empty manifest has size 0', () => {
    expect(Manifest.empty().size()).toBe(0);
  });

  test('from accepts a list and rejects duplicates', () => {
    const m = Manifest.from([sampleImage, sampleSound]);
    expect(m.size()).toBe(2);
    expect(() => Manifest.from([sampleImage, sampleImage])).toThrow(ManifestError);
  });

  test('from rejects entries with invalid slugs', () => {
    expect(() => Manifest.from([{ ...sampleImage, slug: 'NOPE' }])).toThrow(ManifestError);
  });

  test('from rejects entries with invalid type', () => {
    expect(() =>
      Manifest.from([{ ...sampleImage, type: 'sprite' as unknown as 'image' }])
    ).toThrow(ManifestError);
  });
});

describe('Manifest.add / update / delete', () => {
  test('add returns a new manifest containing the entry', () => {
    const m1 = Manifest.empty();
    const m2 = m1.add(sampleImage);
    expect(m1.size()).toBe(0);
    expect(m2.size()).toBe(1);
    expect(m2.get('custom:my-card')?.name).toBe('My card');
  });

  test('add rejects duplicate slug', () => {
    const m = Manifest.empty().add(sampleImage);
    expect(() => m.add(sampleImage)).toThrow(/already exists/);
  });

  test('update is immutable on slug', () => {
    const m = Manifest.empty().add(sampleImage);
    expect(() => m.update('custom:my-card', { slug: 'custom:other' as never })).toThrow(/immutable/);
  });

  test('update is immutable on type', () => {
    const m = Manifest.empty().add(sampleImage);
    expect(() => m.update('custom:my-card', { type: 'sound' })).toThrow(/immutable/);
  });

  test('update merges editable fields and returns a new manifest', () => {
    const m1 = Manifest.empty().add(sampleImage);
    const m2 = m1.update('custom:my-card', { name: 'Renamed', preload: false, tags: ['face'] });
    expect(m1.get('custom:my-card')?.name).toBe('My card');
    expect(m2.get('custom:my-card')?.name).toBe('Renamed');
    expect(m2.get('custom:my-card')?.preload).toBe(false);
    expect(m2.get('custom:my-card')?.tags).toEqual(['face']);
  });

  test('update rejects unknown slug', () => {
    const m = Manifest.empty();
    expect(() => m.update('custom:nope', { name: 'x' })).toThrow(/unknown slug/);
  });

  test('delete returns a new manifest without the entry', () => {
    const m1 = Manifest.empty().add(sampleImage);
    const m2 = m1.delete('custom:my-card');
    expect(m1.hasSlug('custom:my-card')).toBe(true);
    expect(m2.hasSlug('custom:my-card')).toBe(false);
  });

  test('delete is a no-op for an unknown slug', () => {
    const m1 = Manifest.empty().add(sampleImage);
    const m2 = m1.delete('custom:nope');
    expect(m2.size()).toBe(m1.size());
  });
});

describe('Manifest.list / get', () => {
  test('list returns all entries and filters by type', () => {
    const m = Manifest.from([sampleImage, sampleSound]);
    expect(m.list().length).toBe(2);
    expect(m.list({ type: 'image' }).length).toBe(1);
    expect(m.list({ type: 'image' })[0].slug).toBe('custom:my-card');
    expect(m.list({ type: 'model' })).toEqual([]);
  });

  test('get and list return defensive copies', () => {
    const m   = Manifest.from([{ ...sampleImage, tags: ['a', 'b'] }]);
    const got = m.get('custom:my-card')!;
    got.tags!.push('c');
    expect(m.get('custom:my-card')?.tags).toEqual(['a', 'b']);
  });
});

describe('Manifest bundled entries', () => {
  const HASH = 'a'.repeat(64);

  const bundledImage: AssetEntry = {
    slug:    'custom:my-png',
    name:    'My PNG',
    type:    'image',
    url:     '',
    preload: false,
    bundled: true,
    hash:    HASH,
    size:    1024,
  };

  test('accepts a bundled entry with required hash', () => {
    const m = Manifest.empty().add(bundledImage);
    const got = m.get('custom:my-png')!;
    expect(got.bundled).toBe(true);
    expect(got.hash).toBe(HASH);
  });

  test('rejects bundled === true without a hash', () => {
    expect(() =>
      Manifest.empty().add({ ...bundledImage, hash: undefined })
    ).toThrow(/hash/);
  });

  test('rejects malformed hash (wrong length / uppercase / non-hex)', () => {
    expect(() => Manifest.empty().add({ ...bundledImage, hash: 'abc' })).toThrow(/hash/);
    expect(() => Manifest.empty().add({ ...bundledImage, hash: 'A'.repeat(64) })).toThrow(/hash/);
    expect(() => Manifest.empty().add({ ...bundledImage, hash: 'g'.repeat(64) })).toThrow(/hash/);
  });

  test('rejects bundled === true on non-custom namespace', () => {
    expect(() =>
      Manifest.empty().add({ ...bundledImage, slug: 'base:my-png' })
    ).toThrow(/custom/);
    expect(() =>
      Manifest.empty().add({ ...bundledImage, slug: 'prim:my-png' })
    ).toThrow(/custom/);
  });

  test('rejects hash on non-bundled entries', () => {
    expect(() =>
      Manifest.empty().add({ ...sampleImage, hash: HASH })
    ).toThrow(/bundled/);
  });

  test('pre-feature entries (neither bundled nor hash) still validate', () => {
    const m = Manifest.empty().add(sampleImage);
    expect(m.get('custom:my-card')?.bundled).toBeUndefined();
    expect(m.get('custom:my-card')?.hash).toBeUndefined();
  });

  test('update can flip bundled false → true with hash + size in the same call', () => {
    const m  = Manifest.empty().add(sampleImage);
    const m2 = m.update('custom:my-card', { bundled: true, hash: HASH, size: 42 });
    expect(m2.get('custom:my-card')?.bundled).toBe(true);
    expect(m2.get('custom:my-card')?.hash).toBe(HASH);
    expect(m2.get('custom:my-card')?.size).toBe(42);
  });

  test('update can flip bundled true → false when hash + size are cleared in the same call', () => {
    const m  = Manifest.empty().add(bundledImage);
    const m2 = m.update('custom:my-png', { bundled: false, hash: undefined, size: undefined });
    expect(m2.get('custom:my-png')?.bundled).toBe(false);
    expect(m2.get('custom:my-png')?.hash).toBeUndefined();
    expect(m2.get('custom:my-png')?.size).toBeUndefined();
  });

  test('update rejects flipping bundled true → false without clearing hash', () => {
    const m = Manifest.empty().add(bundledImage);
    expect(() => m.update('custom:my-png', { bundled: false })).toThrow(/bundled/);
  });

  test('update rejects clearing hash while bundled remains true', () => {
    const m = Manifest.empty().add(bundledImage);
    expect(() => m.update('custom:my-png', { hash: undefined })).toThrow(/hash/);
  });

  test('rejects bundled === true without a size', () => {
    expect(() =>
      Manifest.empty().add({ ...bundledImage, size: undefined })
    ).toThrow(/size/);
  });

  test('rejects size on non-bundled entries', () => {
    expect(() =>
      Manifest.empty().add({ ...sampleImage, size: 100 })
    ).toThrow(/size/);
  });

  test('rejects negative or non-integer size', () => {
    expect(() => Manifest.empty().add({ ...bundledImage, size: -1 })).toThrow(/size/);
    expect(() => Manifest.empty().add({ ...bundledImage, size: 1.5 })).toThrow(/size/);
  });
});

describe('Manifest spritesheet entries', () => {
  const sheet: AssetEntry = {
    slug: 'custom:deck', name: 'Deck', type: 'spritesheet',
    url: 'http://x/deck.png', preload: true, cols: 13, rows: 4,
  };

  test('add accepts spritesheet with cols/rows', () => {
    const m = Manifest.empty().add(sheet);
    const got = m.get('custom:deck')!;
    expect(got.type).toBe('spritesheet');
    expect(got.cols).toBe(13);
    expect(got.rows).toBe(4);
  });

  test('rejects spritesheet missing cols or rows', () => {
    expect(() => Manifest.empty().add({ ...sheet, cols: undefined })).toThrow(/cols/);
    expect(() => Manifest.empty().add({ ...sheet, rows: undefined })).toThrow(/rows/);
  });

  test('rejects non-positive-integer cols/rows', () => {
    expect(() => Manifest.empty().add({ ...sheet, cols: 0 })).toThrow(/cols/);
    expect(() => Manifest.empty().add({ ...sheet, rows: -1 })).toThrow(/rows/);
    expect(() => Manifest.empty().add({ ...sheet, cols: 1.5 })).toThrow(/cols/);
  });

  test('rejects cols/rows on non-spritesheet types', () => {
    expect(() => Manifest.empty().add({ ...sampleImage, cols: 2 } as AssetEntry)).toThrow(/cols/);
    expect(() => Manifest.empty().add({ ...sampleImage, rows: 2 } as AssetEntry)).toThrow(/rows/);
  });

  test('rejects spritesheet outside the custom namespace', () => {
    expect(() => Manifest.empty().add({ ...sheet, slug: 'base:deck' })).toThrow(/custom/);
    expect(() => Manifest.empty().add({ ...sheet, slug: 'prim:deck' })).toThrow(/custom/);
  });

  test('cols/rows are mutable on update; slug/type still immutable', () => {
    const m  = Manifest.empty().add(sheet);
    const m2 = m.update('custom:deck', { cols: 8, rows: 7 });
    expect(m2.get('custom:deck')?.cols).toBe(8);
    expect(m2.get('custom:deck')?.rows).toBe(7);

    expect(() => m.update('custom:deck', { slug: 'custom:other' as never })).toThrow(/immutable/);
    expect(() => m.update('custom:deck', { type: 'image' })).toThrow(/immutable/);
  });
});

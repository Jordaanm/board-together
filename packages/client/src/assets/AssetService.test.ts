import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { AssetService, type AssetStatus, getImagePlaceholder, getModelPlaceholder } from './AssetService';
import { Manifest, type AssetEntry } from './Manifest';
import { spriteUV } from './spriteUV';
import { BASE_MANIFEST, PRIMITIVE_MANIFEST } from './baseManifest';
import { BundleStore } from './BundleStore';

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

describe('AssetService.subscribe', () => {
  test('fires immediately with pending placeholder, then with the real texture', async () => {
    const real = new THREE.Texture();
    const svc  = new AssetService({ imageLoader: () => Promise.resolve(real) });
    const calls: { tex: THREE.Texture; status: AssetStatus }[] = [];

    svc.subscribe('http://x/a.png', 'image', (tex, status) => {
      calls.push({ tex, status });
    });

    expect(calls.length).toBe(1);
    expect(calls[0].status).toBe('pending');
    expect(calls[0].tex).toBe(getImagePlaceholder());

    await flushMicrotasks();
    expect(calls.length).toBe(2);
    expect(calls[1].status).toBe('loaded');
    expect(calls[1].tex).toBe(real);
  });

  test('falls back to placeholder when the loader rejects', async () => {
    const svc   = new AssetService({ imageLoader: () => Promise.reject(new Error('boom')) });
    const calls: AssetStatus[] = [];

    svc.subscribe('http://x/bad.png', 'image', (_tex, status) => calls.push(status));

    await flushMicrotasks();
    expect(calls).toEqual(['pending', 'broken']);
    expect(svc.status('http://x/bad.png', 'image')).toBe('broken');
  });

  test('dedups concurrent subscribes — same ref triggers one loader call', async () => {
    let calls = 0;
    const real = new THREE.Texture();
    const svc  = new AssetService({
      imageLoader: () => { calls++; return Promise.resolve(real); },
    });

    svc.subscribe('http://x/dedup.png', 'image', () => {});
    svc.subscribe('http://x/dedup.png', 'image', () => {});
    svc.subscribe('http://x/dedup.png', 'image', () => {});

    await flushMicrotasks();
    expect(calls).toBe(1);
  });

  test('a later subscribe to a loaded ref fires once with the cached texture', async () => {
    const real = new THREE.Texture();
    const svc  = new AssetService({ imageLoader: () => Promise.resolve(real) });

    svc.subscribe('http://x/cached.png', 'image', () => {});
    await flushMicrotasks();

    const calls: { tex: THREE.Texture; status: AssetStatus }[] = [];
    svc.subscribe('http://x/cached.png', 'image', (tex, status) => calls.push({ tex, status }));

    expect(calls.length).toBe(1);
    expect(calls[0].status).toBe('loaded');
    expect(calls[0].tex).toBe(real);
  });

  test('unsubscribe stops further notifications for that listener', async () => {
    let pending: ((tex: THREE.Texture) => void) | null = null;
    const svc = new AssetService({
      imageLoader: () => new Promise((res) => { pending = res; }),
    });
    const calls: AssetStatus[] = [];

    const unsub = svc.subscribe('http://x/late.png', 'image', (_tex, status) => calls.push(status));
    unsub();
    pending!(new THREE.Texture());
    await flushMicrotasks();

    expect(calls).toEqual(['pending']);
  });
});

describe('AssetService.resolve', () => {
  test('resolves with the real texture on success', async () => {
    const real = new THREE.Texture();
    const svc  = new AssetService({ imageLoader: () => Promise.resolve(real) });
    const tex  = await svc.resolve('http://x/r.png', 'image');
    expect(tex).toBe(real);
  });

  test('resolves with the placeholder on failure (never rejects)', async () => {
    const svc = new AssetService({ imageLoader: () => Promise.reject(new Error('boom')) });
    const tex = await svc.resolve('http://x/r.png', 'image');
    expect(tex).toBe(getImagePlaceholder());
  });
});

describe('AssetService slug resolution', () => {
  test('resolves a custom slug through the manifest to its URL', async () => {
    const real = new THREE.Texture();
    let loaded = '';
    const custom: AssetEntry = {
      slug:    'custom:my-img',
      name:    'My',
      type:    'image',
      url:     'http://example.com/c.png',
      preload: true,
    };
    const svc = new AssetService({
      manifests:   [Manifest.from([custom])],
      imageLoader: (url) => { loaded = url; return Promise.resolve(real); },
    });

    const tex = await svc.resolve('custom:my-img', 'image');
    expect(loaded).toBe('http://example.com/c.png');
    expect(tex).toBe(real);
  });

  test('unknown slug → placeholder + broken status', async () => {
    const svc   = new AssetService({ manifests: [BASE_MANIFEST] });
    const calls: AssetStatus[] = [];
    svc.subscribe('custom:nope', 'image', (_tex, status) => calls.push(status));
    await flushMicrotasks();
    expect(calls[calls.length - 1]).toBe('broken');
    expect(svc.status('custom:nope', 'image')).toBe('broken');
  });

  test('wrong-type slug → placeholder + broken status', async () => {
    const svc   = new AssetService({ manifests: [BASE_MANIFEST, PRIMITIVE_MANIFEST] });
    const calls: AssetStatus[] = [];
    svc.subscribe('prim:cube', 'image', (_tex, status) => calls.push(status));
    await flushMicrotasks();
    expect(calls[calls.length - 1]).toBe('broken');
  });

  test('base placeholder slug → placeholder texture, loaded status', async () => {
    const svc   = new AssetService({ manifests: [BASE_MANIFEST] });
    const calls: { tex: THREE.Texture; status: AssetStatus }[] = [];
    svc.subscribe('base:placeholder/image', 'image', (tex, status) => calls.push({ tex, status }));
    await flushMicrotasks();
    const last = calls[calls.length - 1];
    expect(last?.status).toBe('loaded');
    expect(last?.tex).toBe(getImagePlaceholder());
  });

  test('placeholder:// marker URL never hits the network loader', async () => {
    let loaded = 0;
    const svc = new AssetService({
      manifests:   [BASE_MANIFEST],
      imageLoader: () => { loaded++; return Promise.resolve(new THREE.Texture()); },
    });
    svc.subscribe('placeholder://image', 'image', () => {});
    await flushMicrotasks();
    expect(loaded).toBe(0);
  });

  test('listAssets returns the union of every wired manifest, deduplicating by slug', () => {
    const m1 = Manifest.from([
      { slug: 'custom:a', name: 'A', type: 'image', url: 'http://x/a.png', preload: false },
      { slug: 'custom:b', name: 'B', type: 'sound', url: 'http://x/b.mp3', preload: true },
    ]);
    const m2 = Manifest.from([
      { slug: 'custom:b', name: 'B-shadowed', type: 'sound', url: 'http://other/b.mp3', preload: false },
      { slug: 'custom:c', name: 'C', type: 'model', url: 'http://x/c.glb', preload: false },
    ]);
    const svc = new AssetService({ manifests: [m1, m2] });

    const all = svc.listAssets();
    expect(all.map(e => e.slug).sort()).toEqual(['custom:a', 'custom:b', 'custom:c']);
    // First manifest wins on duplicate slug.
    expect(all.find(e => e.slug === 'custom:b')!.name).toBe('B');
  });

  test('listAssets filters by type', () => {
    const m = Manifest.from([
      { slug: 'custom:a', name: 'A', type: 'image', url: 'http://x/a.png', preload: false },
      { slug: 'custom:b', name: 'B', type: 'sound', url: 'http://x/b.mp3', preload: true },
    ]);
    const svc = new AssetService({ manifests: [BASE_MANIFEST, m] });
    const sounds = svc.listAssets({ type: 'sound' });
    expect(sounds.some(e => e.slug === 'custom:b')).toBe(true);
    expect(sounds.every(e => e.type === 'sound')).toBe(true);
  });

  test('setManifests evicts cached slug entries so re-resolve picks up the new URL', async () => {
    const t1 = new THREE.Texture();
    const t2 = new THREE.Texture();
    const svc = new AssetService({
      imageLoader: (url) => Promise.resolve(url.endsWith('a.png') ? t1 : t2),
    });
    svc.setManifests([Manifest.from([{
      slug: 'custom:swap', name: 'A', type: 'image', url: 'http://x/a.png', preload: false,
    }])]);
    expect(await svc.resolve('custom:swap', 'image')).toBe(t1);

    svc.setManifests([Manifest.from([{
      slug: 'custom:swap', name: 'A', type: 'image', url: 'http://x/b.png', preload: false,
    }])]);
    expect(await svc.resolve('custom:swap', 'image')).toBe(t2);
  });
});

describe('AssetService model resolution', () => {
  test('subscribe(model) fires placeholder pending then real Object3D loaded', async () => {
    const real = new THREE.Object3D();
    const svc  = new AssetService({ modelLoader: () => Promise.resolve(real) });
    const calls: { obj: THREE.Object3D; status: AssetStatus }[] = [];

    svc.subscribe('http://x/m.glb', 'model', (obj, status) => calls.push({ obj, status }));

    expect(calls[0].status).toBe('pending');
    expect(calls[0].obj).toBe(getModelPlaceholder());

    await flushMicrotasks();
    expect(calls[calls.length - 1].status).toBe('loaded');
    expect(calls[calls.length - 1].obj).toBe(real);
  });

  test('rejected model load → broken status, placeholder retained', async () => {
    const svc = new AssetService({ modelLoader: () => Promise.reject(new Error('boom')) });
    const seen: AssetStatus[] = [];
    svc.subscribe('http://x/bad.glb', 'model', (_obj, s) => seen.push(s));
    await flushMicrotasks();
    expect(seen).toEqual(['pending', 'broken']);
    expect(svc.status('http://x/bad.glb', 'model')).toBe('broken');
  });

  test('custom model slug resolves through manifest', async () => {
    const real = new THREE.Object3D();
    let loaded = '';
    const svc = new AssetService({
      manifests: [Manifest.from([{
        slug: 'custom:knight', name: 'Knight', type: 'model', url: 'http://x/k.glb', preload: false,
      }])],
      modelLoader: (url) => { loaded = url; return Promise.resolve(real); },
    });

    const obj = await svc.resolve('custom:knight', 'model');
    expect(loaded).toBe('http://x/k.glb');
    expect(obj).toBe(real);
  });

  test('unknown model slug falls back to placeholder + broken status', async () => {
    const svc = new AssetService({ manifests: [BASE_MANIFEST] });
    const seen: AssetStatus[] = [];
    svc.subscribe('custom:nope', 'model', (_obj, s) => seen.push(s));
    await flushMicrotasks();
    expect(seen[seen.length - 1]).toBe('broken');
    expect(svc.status('custom:nope', 'model')).toBe('broken');
  });

  test('image-typed slug subscribed as a model is broken', async () => {
    const svc = new AssetService({
      manifests: [Manifest.from([{
        slug: 'custom:img', name: 'I', type: 'image', url: 'http://x/i.png', preload: false,
      }])],
    });
    const seen: AssetStatus[] = [];
    svc.subscribe('custom:img', 'model', (_obj, s) => seen.push(s));
    await flushMicrotasks();
    expect(seen[seen.length - 1]).toBe('broken');
  });
});

describe('AssetService sound resolution', () => {
  const fakeBuffer = (label: string) => ({ __label: label } as unknown as AudioBuffer);

  test('subscribe(sound) fires null pending then real AudioBuffer loaded', async () => {
    const buf = fakeBuffer('a');
    const svc = new AssetService({ soundLoader: () => Promise.resolve(buf) });
    const seen: { buf: AudioBuffer | null; status: AssetStatus }[] = [];
    svc.subscribe('http://x/a.mp3', 'sound', (b, s) => seen.push({ buf: b, status: s }));

    expect(seen[0].status).toBe('pending');
    expect(seen[0].buf).toBeNull();

    await flushMicrotasks();
    expect(seen[seen.length - 1].status).toBe('loaded');
    expect(seen[seen.length - 1].buf).toBe(buf);
  });

  test('rejected sound load → broken status, null buffer', async () => {
    const svc = new AssetService({ soundLoader: () => Promise.reject(new Error('decode failed')) });
    const seen: AssetStatus[] = [];
    svc.subscribe('http://x/bad.mp3', 'sound', (_buf, s) => seen.push(s));
    await flushMicrotasks();
    expect(seen).toEqual(['pending', 'broken']);
    expect(svc.status('http://x/bad.mp3', 'sound')).toBe('broken');
  });

  test('custom sound slug resolves through manifest', async () => {
    const buf = fakeBuffer('roll');
    let loaded = '';
    const svc = new AssetService({
      manifests: [Manifest.from([{
        slug: 'custom:roll', name: 'Roll', type: 'sound', url: 'http://x/r.mp3', preload: false,
      }])],
      soundLoader: (url) => { loaded = url; return Promise.resolve(buf); },
    });
    expect(await svc.resolve('custom:roll', 'sound')).toBe(buf);
    expect(loaded).toBe('http://x/r.mp3');
  });

  test('unknown sound slug falls back to placeholder + broken status', async () => {
    const svc = new AssetService({ manifests: [BASE_MANIFEST] });
    const seen: AssetStatus[] = [];
    svc.subscribe('custom:nope', 'sound', (_buf, s) => seen.push(s));
    await flushMicrotasks();
    expect(seen[seen.length - 1]).toBe('broken');
  });

  test('preload triggers sound loader for sound entries', async () => {
    const calls: string[] = [];
    const svc = new AssetService({
      soundLoader: (url) => { calls.push(url); return Promise.resolve(fakeBuffer('s')); },
    });
    const m = Manifest.from([
      { slug: 'custom:s', name: 'S', type: 'sound', url: 'http://x/s.mp3', preload: true },
    ]);
    svc.setManifests([m]);
    await svc.preload(m);
    expect(calls).toEqual(['http://x/s.mp3']);
  });
});

describe('AssetService.preload', () => {
  test('fetches every preload:true entry across the supplied manifests', async () => {
    const fetched: string[] = [];
    const real = new THREE.Texture();
    const svc  = new AssetService({
      imageLoader: (url) => { fetched.push(url); return Promise.resolve(real); },
    });
    const m = Manifest.from([
      { slug: 'custom:a', name: 'A', type: 'image', url: 'http://x/a.png', preload: true  },
      { slug: 'custom:b', name: 'B', type: 'image', url: 'http://x/b.png', preload: false },
      { slug: 'custom:c', name: 'C', type: 'image', url: 'http://x/c.png', preload: true  },
    ]);
    svc.setManifests([m]);

    await svc.preload(m);
    expect(fetched.sort()).toEqual(['http://x/a.png', 'http://x/c.png']);
  });

  test('skips placeholder:// and primitive:// markers (no network)', async () => {
    let calls = 0;
    const svc = new AssetService({
      imageLoader: () => { calls++; return Promise.resolve(new THREE.Texture()); },
    });
    await svc.preload([BASE_MANIFEST, PRIMITIVE_MANIFEST]);
    expect(calls).toBe(0);
  });

  test('preload routes each entry to its type-appropriate loader', async () => {
    const imageCalls: string[] = [];
    const modelCalls: string[] = [];
    const soundCalls: string[] = [];
    const svc = new AssetService({
      imageLoader: (url) => { imageCalls.push(url); return Promise.resolve(new THREE.Texture()); },
      modelLoader: (url) => { modelCalls.push(url); return Promise.resolve(new THREE.Object3D()); },
      soundLoader: (url) => { soundCalls.push(url); return Promise.resolve({} as AudioBuffer); },
    });
    const m = Manifest.from([
      { slug: 'custom:i', name: 'I', type: 'image', url: 'http://x/i.png', preload: true },
      { slug: 'custom:m', name: 'M', type: 'model', url: 'http://x/m.glb', preload: true },
      { slug: 'custom:s', name: 'S', type: 'sound', url: 'http://x/s.mp3', preload: true },
    ]);
    svc.setManifests([m]);
    await svc.preload(m);
    expect(imageCalls).toEqual(['http://x/i.png']);
    expect(modelCalls).toEqual(['http://x/m.glb']);
    expect(soundCalls).toEqual(['http://x/s.mp3']);
  });

  test('settles even when individual loads reject', async () => {
    const svc = new AssetService({
      imageLoader: (url) => url.endsWith('ok.png')
        ? Promise.resolve(new THREE.Texture())
        : Promise.reject(new Error('boom')),
    });
    const m = Manifest.from([
      { slug: 'custom:ok',  name: 'OK',  type: 'image', url: 'http://x/ok.png',  preload: true },
      { slug: 'custom:bad', name: 'BAD', type: 'image', url: 'http://x/bad.png', preload: true },
    ]);
    svc.setManifests([m]);

    await expect(svc.preload(m)).resolves.toBeUndefined();
    expect(svc.status('custom:ok',  'image')).toBe('loaded');
    expect(svc.status('custom:bad', 'image')).toBe('broken');
  });

  test('progress listener tracks pending count and returns to zero', async () => {
    let resolveLoad!: (tex: THREE.Texture) => void;
    const svc = new AssetService({
      imageLoader: () => new Promise((r) => { resolveLoad = r; }),
    });
    const m = Manifest.from([
      { slug: 'custom:p', name: 'P', type: 'image', url: 'http://x/p.png', preload: true },
    ]);
    svc.setManifests([m]);

    const seen: number[] = [];
    svc.subscribeProgress((n) => seen.push(n));
    expect(seen).toEqual([0]);

    const done = svc.preload(m);
    expect(seen[seen.length - 1]).toBe(1);
    expect(svc.pendingCount()).toBe(1);

    resolveLoad(new THREE.Texture());
    await done;
    expect(seen[seen.length - 1]).toBe(0);
    expect(svc.pendingCount()).toBe(0);
  });
});

describe('AssetService.invalidate', () => {
  test('re-fetches and notifies existing subscribers', async () => {
    let calls = 0;
    const t1 = new THREE.Texture();
    const t2 = new THREE.Texture();
    const svc = new AssetService({
      imageLoader: () => Promise.resolve(calls++ === 0 ? t1 : t2),
    });
    const seen: AssetStatus[] = [];
    svc.subscribe('http://x/inv.png', 'image', (_tex, status) => seen.push(status));

    await flushMicrotasks();
    expect(seen).toEqual(['pending', 'loaded']);

    svc.invalidate('http://x/inv.png');
    await flushMicrotasks();
    expect(seen).toEqual(['pending', 'loaded', 'pending', 'loaded']);
    expect(calls).toBe(2);
  });

  test('broken → loaded transition after invalidate (e.g. host fixes URL)', async () => {
    let attempt = 0;
    const real = new THREE.Texture();
    const svc = new AssetService({
      imageLoader: () =>
        attempt++ === 0 ? Promise.reject(new Error('404')) : Promise.resolve(real),
    });
    const seen: AssetStatus[] = [];
    svc.subscribe('http://x/heal.png', 'image', (_tex, s) => seen.push(s));
    await flushMicrotasks();
    expect(seen).toEqual(['pending', 'broken']);

    svc.invalidate('http://x/heal.png');
    await flushMicrotasks();
    expect(seen).toEqual(['pending', 'broken', 'pending', 'loaded']);
    expect(svc.status('http://x/heal.png', 'image')).toBe('loaded');
  });

  test('setManifests re-fetches cached slugs through invalidate, preserving listeners', async () => {
    const t1 = new THREE.Texture();
    const t2 = new THREE.Texture();
    let attempt = 0;
    const svc = new AssetService({
      imageLoader: () => Promise.resolve(attempt++ === 0 ? t1 : t2),
    });
    svc.setManifests([Manifest.from([{
      slug: 'custom:x', name: 'X', type: 'image', url: 'http://x/old.png', preload: false,
    }])]);

    const seen: { tex: THREE.Texture; status: AssetStatus }[] = [];
    svc.subscribe('custom:x', 'image', (tex, status) => seen.push({ tex, status }));
    await flushMicrotasks();
    expect(seen[seen.length - 1].tex).toBe(t1);

    svc.setManifests([Manifest.from([{
      slug: 'custom:x', name: 'X', type: 'image', url: 'http://x/new.png', preload: false,
    }])]);
    await flushMicrotasks();
    // Listener survives — observes pending then the new texture.
    expect(seen[seen.length - 1].tex).toBe(t2);
    expect(seen[seen.length - 1].status).toBe('loaded');
  });
});

describe('AssetService sprite-ref resolution', () => {
  const sheetEntry: AssetEntry = {
    slug: 'custom:deck', name: 'Deck', type: 'spritesheet',
    url: 'http://x/deck.png', preload: false, cols: 13, rows: 4,
  };

  test('sprite-ref subscribe fires loaded with cloned texture + UV offset/repeat', async () => {
    const parent = new THREE.Texture();
    const svc = new AssetService({
      manifests:   [Manifest.from([sheetEntry])],
      imageLoader: () => Promise.resolve(parent),
    });
    const seen: { tex: THREE.Texture; status: AssetStatus }[] = [];
    svc.subscribe('custom:deck:0', 'image', (tex, status) => seen.push({ tex, status }));

    expect(seen[0].status).toBe('pending');
    expect(seen[0].tex).toBe(getImagePlaceholder());

    await flushMicrotasks();
    const last = seen[seen.length - 1];
    expect(last.status).toBe('loaded');
    expect(last.tex).not.toBe(parent);            // cloned
    expect(last.tex.image).toBe(parent.image);    // shared image source
    const uv0 = spriteUV(0, 13, 4);
    expect(last.tex.offset.x).toBeCloseTo(uv0.offsetX);
    expect(last.tex.offset.y).toBeCloseTo(uv0.offsetY);
    expect(last.tex.repeat.x).toBeCloseTo(uv0.repeatX);
    expect(last.tex.repeat.y).toBeCloseTo(uv0.repeatY);
  });

  test('parent sheet load sets generateMipmaps=false and linear filters', async () => {
    const parent = new THREE.Texture();
    parent.generateMipmaps = true;
    parent.minFilter       = THREE.NearestMipmapLinearFilter;
    parent.magFilter       = THREE.NearestFilter;
    const svc = new AssetService({
      manifests:   [Manifest.from([sheetEntry])],
      imageLoader: () => Promise.resolve(parent),
    });
    svc.subscribe('custom:deck:0', 'image', () => {});
    await flushMicrotasks();
    expect(parent.generateMipmaps).toBe(false);
    expect(parent.minFilter).toBe(THREE.LinearFilter);
    expect(parent.magFilter).toBe(THREE.LinearFilter);
  });

  test('two sprite refs to the same sheet share one fetch', async () => {
    let calls = 0;
    const parent = new THREE.Texture();
    const svc = new AssetService({
      manifests:   [Manifest.from([sheetEntry])],
      imageLoader: () => { calls++; return Promise.resolve(parent); },
    });
    svc.subscribe('custom:deck:0', 'image', () => {});
    svc.subscribe('custom:deck:5', 'image', () => {});
    await flushMicrotasks();
    expect(calls).toBe(1);
  });

  test('two sprite refs to the same sheet yield distinct cloned textures', async () => {
    const parent = new THREE.Texture();
    const svc = new AssetService({
      manifests:   [Manifest.from([sheetEntry])],
      imageLoader: () => Promise.resolve(parent),
    });
    let tex0: THREE.Texture | null = null;
    let tex1: THREE.Texture | null = null;
    svc.subscribe('custom:deck:0', 'image', (t, s) => { if (s === 'loaded') tex0 = t; });
    svc.subscribe('custom:deck:1', 'image', (t, s) => { if (s === 'loaded') tex1 = t; });
    await flushMicrotasks();
    expect(tex0).not.toBe(null);
    expect(tex1).not.toBe(null);
    expect(tex0).not.toBe(tex1);
    expect(tex0!.offset.x).not.toBeCloseTo(tex1!.offset.x);
  });

  test('out-of-bounds sprite index → broken', async () => {
    const svc = new AssetService({
      manifests:   [Manifest.from([sheetEntry])],
      imageLoader: () => Promise.resolve(new THREE.Texture()),
    });
    const seen: AssetStatus[] = [];
    svc.subscribe('custom:deck:9999', 'image', (_t, s) => seen.push(s));
    await flushMicrotasks();
    expect(seen[seen.length - 1]).toBe('broken');
  });

  test('missing parent sheet → broken', async () => {
    const svc = new AssetService({ manifests: [BASE_MANIFEST] });
    const seen: AssetStatus[] = [];
    svc.subscribe('custom:nope:0', 'image', (_t, s) => seen.push(s));
    await flushMicrotasks();
    expect(seen[seen.length - 1]).toBe('broken');
  });

  test('sheet load failure → all sprite subscribers go broken', async () => {
    const svc = new AssetService({
      manifests:   [Manifest.from([sheetEntry])],
      imageLoader: () => Promise.reject(new Error('404')),
    });
    const seen: AssetStatus[] = [];
    svc.subscribe('custom:deck:0', 'image', (_t, s) => seen.push(s));
    await flushMicrotasks();
    expect(seen).toEqual(['pending', 'broken']);
  });

  test('preload of a spritesheet entry fetches the sheet exactly once', async () => {
    let calls = 0;
    const svc = new AssetService({
      imageLoader: () => { calls++; return Promise.resolve(new THREE.Texture()); },
    });
    const m = Manifest.from([{ ...sheetEntry, preload: true }]);
    svc.setManifests([m]);
    await svc.preload(m);
    expect(calls).toBe(1);
  });

  test('preload then subscribe reuses the prefetched sheet', async () => {
    let calls = 0;
    const svc = new AssetService({
      imageLoader: () => { calls++; return Promise.resolve(new THREE.Texture()); },
    });
    const m = Manifest.from([{ ...sheetEntry, preload: true }]);
    svc.setManifests([m]);
    await svc.preload(m);
    svc.subscribe('custom:deck:0', 'image', () => {});
    svc.subscribe('custom:deck:1', 'image', () => {});
    await flushMicrotasks();
    expect(calls).toBe(1);
  });

  test('invalidate(sheetSlug) refires all sprite subscribers', async () => {
    let attempt = 0;
    const svc = new AssetService({
      manifests:   [Manifest.from([sheetEntry])],
      imageLoader: () => Promise.resolve((attempt++, new THREE.Texture())),
    });
    const seenA: AssetStatus[] = [];
    const seenB: AssetStatus[] = [];
    svc.subscribe('custom:deck:0', 'image', (_t, s) => seenA.push(s));
    svc.subscribe('custom:deck:5', 'image', (_t, s) => seenB.push(s));
    await flushMicrotasks();
    expect(seenA).toEqual(['pending', 'loaded']);
    expect(seenB).toEqual(['pending', 'loaded']);

    svc.invalidate('custom:deck');
    await flushMicrotasks();
    expect(seenA).toEqual(['pending', 'loaded', 'pending', 'loaded']);
    expect(seenB).toEqual(['pending', 'loaded', 'pending', 'loaded']);
    expect(attempt).toBe(2);
  });

  test('grid-shrunk-out sprite ref → broken after setManifests', async () => {
    const svc = new AssetService({
      imageLoader: () => Promise.resolve(new THREE.Texture()),
    });
    svc.setManifests([Manifest.from([{ ...sheetEntry, cols: 10, rows: 10 }])]);
    const seen: AssetStatus[] = [];
    svc.subscribe('custom:deck:99', 'image', (_t, s) => seen.push(s));
    await flushMicrotasks();
    expect(seen[seen.length - 1]).toBe('loaded');

    svc.setManifests([Manifest.from([{ ...sheetEntry, cols: 5, rows: 5 }])]);
    await flushMicrotasks();
    expect(seen[seen.length - 1]).toBe('broken');
  });

  test('sprite ref subscribed before manifest arrives goes broken, then recovers after setManifests', async () => {
    const svc = new AssetService({
      imageLoader: () => Promise.resolve(new THREE.Texture()),
    });
    const seen: AssetStatus[] = [];
    svc.subscribe('custom:deck:0', 'image', (_t, s) => seen.push(s));
    await flushMicrotasks();
    expect(seen[seen.length - 1]).toBe('broken');

    svc.setManifests([Manifest.from([sheetEntry])]);
    await flushMicrotasks();
    expect(seen[seen.length - 1]).toBe('loaded');
  });
});

// Object URL helpers don't exist in the node test environment. Tests that
// exercise the bundled load path stub them onto globalThis so they can both
// fake the URL string the loader receives and assert revoke is called once
// after each decode.
function stubObjectUrl(): { createMock: ReturnType<typeof vi.fn>; revokeMock: ReturnType<typeof vi.fn>; restore: () => void } {
  let id = 0;
  const createMock = vi.fn((blob: Blob) => `blob:fake#${++id}-size${blob.size}`);
  const revokeMock = vi.fn();
  const URLAny    = URL as unknown as Record<string, unknown>;
  const original  = {
    create: URLAny.createObjectURL,
    revoke: URLAny.revokeObjectURL,
  };
  URLAny.createObjectURL = createMock;
  URLAny.revokeObjectURL = revokeMock;
  return {
    createMock,
    revokeMock,
    restore: () => {
      if (original.create === undefined) delete URLAny.createObjectURL;
      else                                URLAny.createObjectURL = original.create;
      if (original.revoke === undefined) delete URLAny.revokeObjectURL;
      else                                URLAny.revokeObjectURL = original.revoke;
    },
  };
}

const HASH = 'a'.repeat(64);

const bundledImageEntry: AssetEntry = {
  slug: 'custom:bundled-img', name: 'BImg', type: 'image',
  url:  '', preload: false, bundled: true, hash: HASH, size: 3,
};

const bundledModelEntry: AssetEntry = {
  slug: 'custom:bundled-mdl', name: 'BMdl', type: 'model',
  url:  '', preload: false, bundled: true, hash: HASH, size: 5,
};

const bundledSoundEntry: AssetEntry = {
  slug: 'custom:bundled-snd', name: 'BSnd', type: 'sound',
  url:  '', preload: false, bundled: true, hash: HASH, size: 5,
};

describe('AssetService — bundled entries via BundleStore', () => {
  let urlStub: ReturnType<typeof stubObjectUrl>;

  beforeEach(() => { urlStub = stubObjectUrl(); });
  afterEach(()  => { urlStub.restore(); });

  test('image bundled hit loads via object URL and revokes once after decode', async () => {
    const tex   = new THREE.Texture();
    const store = new BundleStore();
    store.put(HASH, new Blob([new Uint8Array([1, 2, 3])]));
    const seenUrls: string[] = [];
    const svc = new AssetService({
      manifests:   [Manifest.from([bundledImageEntry])],
      imageLoader: (url) => { seenUrls.push(url); return Promise.resolve(tex); },
      bundleStore: store,
    });
    const seen: { status: AssetStatus; tex: THREE.Texture }[] = [];
    svc.subscribe('custom:bundled-img', 'image', (t, s) => seen.push({ tex: t, status: s }));
    await flushMicrotasks();

    expect(seen.map(s => s.status)).toEqual(['pending', 'loaded']);
    expect(seen[1].tex).toBe(tex);
    expect(seenUrls.length).toBe(1);
    expect(seenUrls[0]).toMatch(/^blob:fake#/);
    expect(urlStub.createMock).toHaveBeenCalledTimes(1);
    expect(urlStub.revokeMock).toHaveBeenCalledTimes(1);
    expect(urlStub.revokeMock).toHaveBeenCalledWith(seenUrls[0]);
  });

  test('image bundled miss → broken status, no loader call, no object URL', async () => {
    const loader = vi.fn();
    const svc = new AssetService({
      manifests:   [Manifest.from([bundledImageEntry])],
      imageLoader: loader,
      bundleStore: new BundleStore(),
    });
    const seen: AssetStatus[] = [];
    svc.subscribe('custom:bundled-img', 'image', (_t, s) => seen.push(s));
    await flushMicrotasks();
    expect(seen).toEqual(['pending', 'broken']);
    expect(loader).not.toHaveBeenCalled();
    expect(urlStub.createMock).not.toHaveBeenCalled();
  });

  test('image bundled with no bundleStore configured → broken', async () => {
    const loader = vi.fn();
    const svc = new AssetService({
      manifests:   [Manifest.from([bundledImageEntry])],
      imageLoader: loader,
    });
    const seen: AssetStatus[] = [];
    svc.subscribe('custom:bundled-img', 'image', (_t, s) => seen.push(s));
    await flushMicrotasks();
    expect(seen).toEqual(['pending', 'broken']);
    expect(loader).not.toHaveBeenCalled();
  });

  test('model bundled hit resolves to the loader Object3D', async () => {
    const obj   = new THREE.Group();
    const store = new BundleStore();
    store.put(HASH, new Blob([new Uint8Array(5)]));
    const svc = new AssetService({
      manifests:   [Manifest.from([bundledModelEntry])],
      modelLoader: () => Promise.resolve(obj),
      bundleStore: store,
    });
    const seen: { obj: THREE.Object3D; status: AssetStatus }[] = [];
    svc.subscribe('custom:bundled-mdl', 'model', (o, s) => seen.push({ obj: o, status: s }));
    await flushMicrotasks();
    expect(seen.map(s => s.status)).toEqual(['pending', 'loaded']);
    expect(seen[1].obj).toBe(obj);
    expect(urlStub.revokeMock).toHaveBeenCalledTimes(1);
  });

  test('sound bundled hit resolves to the loader AudioBuffer', async () => {
    const buf   = { duration: 1 } as unknown as AudioBuffer;
    const store = new BundleStore();
    store.put(HASH, new Blob([new Uint8Array(5)]));
    const svc = new AssetService({
      manifests:   [Manifest.from([bundledSoundEntry])],
      soundLoader: () => Promise.resolve(buf),
      bundleStore: store,
    });
    const seen: { buf: AudioBuffer | null; status: AssetStatus }[] = [];
    svc.subscribe('custom:bundled-snd', 'sound', (b, s) => seen.push({ buf: b, status: s }));
    await flushMicrotasks();
    expect(seen.map(s => s.status)).toEqual(['pending', 'loaded']);
    expect(seen[1].buf).toBe(buf);
    expect(urlStub.revokeMock).toHaveBeenCalledTimes(1);
  });

  test('object URL revoked exactly once even when the loader rejects', async () => {
    const store = new BundleStore();
    store.put(HASH, new Blob(['x']));
    const svc = new AssetService({
      manifests:   [Manifest.from([bundledImageEntry])],
      imageLoader: () => Promise.reject(new Error('decode failed')),
      bundleStore: store,
    });
    const seen: AssetStatus[] = [];
    svc.subscribe('custom:bundled-img', 'image', (_t, s) => seen.push(s));
    await flushMicrotasks();
    expect(seen).toEqual(['pending', 'broken']);
    expect(urlStub.createMock).toHaveBeenCalledTimes(1);
    expect(urlStub.revokeMock).toHaveBeenCalledTimes(1);
  });

  test('bundled spritesheet — sprite refs resolve via the BundleStore', async () => {
    // Regression: startSheetLoad used to call imageLoader(found.url) which
    // is the empty string for bundled sheets, so sprite refs never rendered.
    const parent = new THREE.Texture();
    const SHEET_HASH = 'a'.repeat(64);
    const store = new BundleStore();
    store.put(SHEET_HASH, new Blob([new Uint8Array([1, 2, 3])]));
    const sheet: AssetEntry = {
      slug: 'custom:bundled-sheet', name: 'BSheet', type: 'spritesheet',
      url:  '', preload: false, bundled: true, hash: SHEET_HASH, size: 3,
      cols: 4, rows: 4,
    };
    let imageLoaderCalls = 0;
    const svc = new AssetService({
      manifests:   [Manifest.from([sheet])],
      imageLoader: () => { imageLoaderCalls++; return Promise.resolve(parent); },
      bundleStore: store,
    });
    const seen: { tex: THREE.Texture; status: AssetStatus }[] = [];
    svc.subscribe('custom:bundled-sheet:0', 'image', (t, s) => seen.push({ tex: t, status: s }));
    await flushMicrotasks();
    expect(seen[seen.length - 1].status).toBe('loaded');
    expect(seen[seen.length - 1].tex).not.toBe(parent);              // cloned
    expect(seen[seen.length - 1].tex.image).toBe(parent.image);       // shared image source
    expect(imageLoaderCalls).toBe(1);
    expect(urlStub.createMock).toHaveBeenCalledTimes(1);
    expect(urlStub.revokeMock).toHaveBeenCalledTimes(1);
  });

  test('bundled spritesheet — BundleStore miss → broken sprite refs', async () => {
    const sheet: AssetEntry = {
      slug: 'custom:bundled-sheet', name: 'BSheet', type: 'spritesheet',
      url:  '', preload: false, bundled: true, hash: HASH, size: 3,
      cols: 2, rows: 2,
    };
    const svc = new AssetService({
      manifests:   [Manifest.from([sheet])],
      imageLoader: () => Promise.resolve(new THREE.Texture()),
      bundleStore: new BundleStore(),  // empty — miss
    });
    const seen: AssetStatus[] = [];
    svc.subscribe('custom:bundled-sheet:1', 'image', (_t, s) => seen.push(s));
    await flushMicrotasks();
    expect(seen[seen.length - 1]).toBe('broken');
  });

  test('non-bundled URL entries do NOT touch URL.createObjectURL', async () => {
    const svc = new AssetService({
      imageLoader: () => Promise.resolve(new THREE.Texture()),
      bundleStore: new BundleStore(),
    });
    svc.subscribe('http://x/normal.png', 'image', () => {});
    await flushMicrotasks();
    expect(urlStub.createMock).not.toHaveBeenCalled();
    expect(urlStub.revokeMock).not.toHaveBeenCalled();
  });
});

// Minimal fake BundleTransport for the wire-fallback tests. Resolves
// `request(hash)` against an in-memory `served` map; supports cancel and
// a "drop" mode that returns a rejection to simulate host disconnect.
function makeFakeTransport(): {
  serve: (hash: string, blob: Blob) => void;
  setMode: (mode: 'normal' | 'unknown' | 'drop' | 'hang') => void;
  requestCount: () => number;
  asTransport: () => { request: (hash: string) => { promise: Promise<Blob>; cancel: () => void } };
  flushHangs: () => void;
} {
  const served = new Map<string, Blob>();
  let mode: 'normal' | 'unknown' | 'drop' | 'hang' = 'normal';
  let count = 0;
  const hangResolvers: Array<{ resolve: (blob: Blob) => void; reject: (err: Error) => void; hash: string }> = [];
  return {
    serve: (hash, blob) => { served.set(hash, blob); },
    setMode: (m) => { mode = m; },
    requestCount: () => count,
    flushHangs: () => {
      const queued = hangResolvers.splice(0);
      for (const r of queued) {
        const b = served.get(r.hash);
        if (b) r.resolve(b);
        else r.reject(new Error('unknown-hash'));
      }
    },
    asTransport: () => ({
      request: (hash) => {
        count++;
        if (mode === 'unknown') {
          return { promise: Promise.reject(new Error('unknown-hash')), cancel: () => {} };
        }
        if (mode === 'drop') {
          return { promise: Promise.reject(new Error('channel-closed')), cancel: () => {} };
        }
        if (mode === 'hang') {
          let resolveFn!: (blob: Blob) => void;
          let rejectFn!:  (err: Error) => void;
          const promise = new Promise<Blob>((res, rej) => { resolveFn = res; rejectFn = rej; });
          const entry = { resolve: resolveFn, reject: rejectFn, hash };
          hangResolvers.push(entry);
          const cancel = () => {
            const i = hangResolvers.indexOf(entry);
            if (i >= 0) hangResolvers.splice(i, 1);
            rejectFn(new Error('cancelled'));
          };
          return { promise, cancel };
        }
        const blob = served.get(hash);
        if (!blob) return { promise: Promise.reject(new Error('unknown-hash')), cancel: () => {} };
        return { promise: Promise.resolve(blob), cancel: () => {} };
      },
    }),
  };
}

describe('AssetService — bundled wire fallback', () => {
  let urlStub: ReturnType<typeof stubObjectUrl>;

  beforeEach(() => { urlStub = stubObjectUrl(); });
  afterEach(()  => { urlStub.restore(); });

  test('store miss → transport hit populates store and resolves loaded', async () => {
    const tex = new THREE.Texture();
    const blob = new Blob([new Uint8Array([5, 5, 5])]);
    const fake = makeFakeTransport();
    fake.serve(HASH, blob);
    const store = new BundleStore();
    const svc = new AssetService({
      manifests:       [Manifest.from([bundledImageEntry])],
      imageLoader:     () => Promise.resolve(tex),
      bundleStore:     store,
      bundleTransport: fake.asTransport() as never,
    });
    const seen: AssetStatus[] = [];
    svc.subscribe('custom:bundled-img', 'image', (_t, s) => seen.push(s));
    await flushMicrotasks();
    expect(seen).toEqual(['pending', 'loaded']);
    expect(store.has(HASH)).toBe(true);
    expect(fake.requestCount()).toBe(1);
  });

  test('cache hit short-circuits the transport — no wire request made', async () => {
    const { BundleCache } = await import('./BundleCache');
    const fake  = makeFakeTransport();
    const blob  = new Blob([new Uint8Array([7])]);
    const driver: import('./BundleCache').BundleCacheDriver = {
      async get(h)  { return h === HASH ? { hash: HASH, blob, size: 1, lastAccessed: 1, pinned: false } : undefined; },
      async put()   {},
      async delete(){},
      async list()  { return []; },
    };
    const cache = new BundleCache({ driver });
    const store = new BundleStore();
    const svc = new AssetService({
      manifests:       [Manifest.from([bundledImageEntry])],
      imageLoader:     () => Promise.resolve(new THREE.Texture()),
      bundleStore:     store,
      bundleCache:     cache,
      bundleTransport: fake.asTransport() as never,
    });
    const seen: AssetStatus[] = [];
    svc.subscribe('custom:bundled-img', 'image', (_t, s) => seen.push(s));
    await flushMicrotasks();
    expect(seen[seen.length - 1]).toBe('loaded');
    expect(fake.requestCount()).toBe(0);
    // Cache hit should populate the in-memory store too.
    expect(store.has(HASH)).toBe(true);
  });

  test('unsubscribe with zero listeners cancels in-flight wire pull', async () => {
    const fake = makeFakeTransport();
    fake.setMode('hang');
    const svc = new AssetService({
      manifests:       [Manifest.from([bundledImageEntry])],
      imageLoader:     () => Promise.resolve(new THREE.Texture()),
      bundleStore:     new BundleStore(),
      bundleTransport: fake.asTransport() as never,
    });
    const unsubscribe = svc.subscribe('custom:bundled-img', 'image', () => {});
    await flushMicrotasks();
    expect(fake.requestCount()).toBe(1);
    unsubscribe();
    // Re-subscribing should fire a fresh request (entry was dropped).
    svc.subscribe('custom:bundled-img', 'image', () => {});
    await flushMicrotasks();
    expect(fake.requestCount()).toBe(2);
  });

  test('transport rejection → broken status (e.g. host disconnect mid-pull)', async () => {
    const fake = makeFakeTransport();
    fake.setMode('drop');
    const svc = new AssetService({
      manifests:       [Manifest.from([bundledImageEntry])],
      imageLoader:     () => Promise.resolve(new THREE.Texture()),
      bundleStore:     new BundleStore(),
      bundleTransport: fake.asTransport() as never,
    });
    const seen: AssetStatus[] = [];
    svc.subscribe('custom:bundled-img', 'image', (_t, s) => seen.push(s));
    await flushMicrotasks();
    expect(seen).toEqual(['pending', 'broken']);
  });

  test('concurrent subscribes to two bundled entries fire two parallel requests', async () => {
    const fake = makeFakeTransport();
    const HASH2 = 'b'.repeat(64);
    const blob1 = new Blob([new Uint8Array([1])]);
    const blob2 = new Blob([new Uint8Array([2])]);
    fake.serve(HASH,  blob1);
    fake.serve(HASH2, blob2);
    const svc = new AssetService({
      manifests:       [Manifest.from([
        bundledImageEntry,
        { ...bundledImageEntry, slug: 'custom:bundled-img-2', hash: HASH2 },
      ])],
      imageLoader:     () => Promise.resolve(new THREE.Texture()),
      bundleStore:     new BundleStore(),
      bundleTransport: fake.asTransport() as never,
    });
    svc.subscribe('custom:bundled-img',   'image', () => {});
    svc.subscribe('custom:bundled-img-2', 'image', () => {});
    await flushMicrotasks();
    expect(fake.requestCount()).toBe(2);
  });
});

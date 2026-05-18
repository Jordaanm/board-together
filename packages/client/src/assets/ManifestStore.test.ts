import { describe, test, expect } from 'vitest';
import { ManifestStore } from './ManifestStore';
import { Manifest, type AssetEntry } from './Manifest';

const a: AssetEntry = { slug: 'custom:a', name: 'A', type: 'image', url: 'http://x/a.png', preload: true };
const b: AssetEntry = { slug: 'custom:b', name: 'B', type: 'image', url: 'http://x/b.png', preload: true };
const c: AssetEntry = { slug: 'custom:c', name: 'C', type: 'sound', url: 'http://x/c.mp3', preload: false };

describe('ManifestStore — initial state', () => {
  test('empty store has equal draft and published', () => {
    const s = new ManifestStore();
    expect(s.getDraft().size()).toBe(0);
    expect(s.getPublished().size()).toBe(0);
    expect(s.unpushedCount()).toBe(0);
  });

  test('initial manifest seeds both draft and published', () => {
    const seed = Manifest.from([a, b]);
    const s    = new ManifestStore(seed);
    expect(s.getDraft().toArray()).toEqual([a, b]);
    expect(s.getPublished().toArray()).toEqual([a, b]);
    expect(s.unpushedCount()).toBe(0);
  });
});

describe('ManifestStore — editDraft + unpushedCount', () => {
  test('add to draft increments unpushedCount', () => {
    const s = new ManifestStore();
    s.editDraft((d) => d.add(a));
    expect(s.unpushedCount()).toBe(1);
    expect(s.getDraft().hasSlug('custom:a')).toBe(true);
    expect(s.getPublished().hasSlug('custom:a')).toBe(false);
  });

  test('edit + delete each count as a single unpushed change', () => {
    const seed = Manifest.from([a, b]);
    const s    = new ManifestStore(seed);
    s.editDraft((d) => d.update('custom:a', { name: 'A renamed' }));
    s.editDraft((d) => d.delete('custom:b'));
    expect(s.unpushedCount()).toBe(2);
  });

  test('reverting an edit drops the unpushed count back to 0', () => {
    const seed = Manifest.from([a]);
    const s    = new ManifestStore(seed);
    s.editDraft((d) => d.update('custom:a', { name: 'temp' }));
    expect(s.unpushedCount()).toBe(1);
    s.editDraft((d) => d.update('custom:a', { name: 'A' }));
    expect(s.unpushedCount()).toBe(0);
  });

  test('flipping bundled / hash is detected by unpushedCount', () => {
    const HASH = 'a'.repeat(64);
    const seed = Manifest.from([a]);
    const s    = new ManifestStore(seed);
    s.editDraft((d) => d.update('custom:a', { bundled: true, hash: HASH, size: 64 }));
    expect(s.unpushedCount()).toBe(1);
    s.push();
    s.editDraft((d) => d.update('custom:a', { bundled: false, hash: undefined, size: undefined }));
    expect(s.unpushedCount()).toBe(1);
  });
});

describe('ManifestStore — push', () => {
  test('promotes draft to published and returns the snapshot', () => {
    const s = new ManifestStore();
    s.editDraft((d) => d.add(a).add(b));
    const snap = s.push();
    expect(snap).toEqual([a, b]);
    expect(s.unpushedCount()).toBe(0);
    expect(s.getPublished().toArray()).toEqual([a, b]);
  });

  test('snapshot is a fresh array, independent of further edits', () => {
    const s = new ManifestStore();
    s.editDraft((d) => d.add(a));
    const snap = s.push();
    s.editDraft((d) => d.add(b));
    expect(snap).toEqual([a]);
  });
});

describe('ManifestStore — applyPublishedSnapshot + loadFromSave', () => {
  test('applyPublishedSnapshot sets both draft and published (guest path)', () => {
    const guest = new ManifestStore();
    guest.applyPublishedSnapshot([a, c]);
    expect(guest.getDraft().toArray()).toEqual([a, c]);
    expect(guest.getPublished().toArray()).toEqual([a, c]);
    expect(guest.unpushedCount()).toBe(0);
  });

  test('loadFromSave synchronises draft and published (host reload)', () => {
    const host = new ManifestStore();
    host.editDraft((d) => d.add(a));
    expect(host.unpushedCount()).toBe(1);
    host.loadFromSave([a, b]);
    expect(host.unpushedCount()).toBe(0);
    expect(host.getDraft().toArray()).toEqual([a, b]);
    expect(host.getPublished().toArray()).toEqual([a, b]);
  });
});

describe('ManifestStore — subscribe', () => {
  test('notifies on edit, push, applyPublishedSnapshot, loadFromSave', () => {
    const s = new ManifestStore();
    let notifies = 0;
    s.subscribe(() => { notifies++; });
    s.editDraft((d) => d.add(a));
    s.push();
    s.applyPublishedSnapshot([b]);
    s.loadFromSave([c]);
    expect(notifies).toBe(4);
  });

  test('editDraft no-op (function returns same manifest) does not notify', () => {
    const s = new ManifestStore();
    let notifies = 0;
    s.subscribe(() => { notifies++; });
    s.editDraft((d) => d.delete('custom:nope')); // delete on absent slug returns same instance
    expect(notifies).toBe(0);
  });
});

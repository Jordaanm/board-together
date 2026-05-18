import { describe, test, expect, vi, beforeEach } from 'vitest';
import { type EntitySerialized } from './Scene';
import { type AssetEntry } from '../assets/Manifest';
import {
  SAVE_FORMAT,
  SAVE_VERSION,
  decodeSaveZip,
  looksLikeSaveZip,
} from './SaveFile';
import { registerCorePrimitives } from './spawnables';

registerCorePrimitives();

const downloadMock = vi.fn();

vi.mock('./SaveFile', async () => {
  const actual = await vi.importActual<typeof import('./SaveFile')>('./SaveFile');
  return {
    ...actual,
    downloadSaveBlob: (blob: Blob, filename: string) => downloadMock(blob, filename),
  };
});

const { downloadSceneFile } = await import('./downloadSceneFile');

const sampleScene: EntitySerialized[] = [
  {
    id:            'd-1',
    type:          'die',
    name:          'Die',
    tags:          ['die'],
    owner:         null,
    privateToSeat: null,
    parentId:      null,
    children:      [],
    components: {
      transform: { position: [0, 5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      value:     { value: '6', isNumeric: true },
    },
  },
];

const sampleManifest: AssetEntry[] = [
  { slug: 'custom:m', name: 'M', type: 'image', url: 'http://x', preload: true },
];

describe('downloadSceneFile', () => {
  beforeEach(() => {
    downloadMock.mockReset();
  });

  test('triggers a .boardtogether zip download', async () => {
    await downloadSceneFile(sampleScene, 'data:image/png;base64,xxx', sampleManifest, { source: 'src', initialised: true });
    expect(downloadMock).toHaveBeenCalledTimes(1);
    const [blob, filename] = downloadMock.mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(filename).toMatch(/^vtt-scene-.*\.boardtogether$/);
  });

  test('downloaded blob is a zip whose envelope round-trips', async () => {
    await downloadSceneFile(sampleScene, 'data:image/png;base64,xxx', sampleManifest, { source: 'src', initialised: true });
    const [blob] = downloadMock.mock.calls[0] as [Blob, string];
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(looksLikeSaveZip(bytes)).toBe(true);
    const { envelope, blobs } = await decodeSaveZip(bytes);
    expect(envelope.format).toBe(SAVE_FORMAT);
    expect(envelope.version).toBe(SAVE_VERSION);
    expect(envelope.scene).toEqual(sampleScene);
    expect(envelope.thumbnail).toBe('data:image/png;base64,xxx');
    expect(envelope.manifest).toEqual(sampleManifest);
    expect(envelope.script).toEqual({ source: 'src', initialised: true });
    expect(blobs).toEqual([]);
  });

  test('defaults script to empty when undefined', async () => {
    await downloadSceneFile([], null, [], undefined);
    const [blob] = downloadMock.mock.calls[0] as [Blob, string];
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { envelope } = await decodeSaveZip(bytes);
    expect(envelope.script).toEqual({ source: '', initialised: false });
    expect(envelope.thumbnail).toBeNull();
    expect(envelope.manifest).toEqual([]);
    expect(envelope.scene).toEqual([]);
  });

  test('zero-bundle save is small (~kilobyte order)', async () => {
    await downloadSceneFile([], null, [], undefined);
    const [blob] = downloadMock.mock.calls[0] as [Blob, string];
    // sanity: empty scene zip should fit well under 1KB.
    expect(blob.size).toBeLessThan(1024);
  });

  test('pulls bytes from BundleStore by hash; dedupes when two entries share a hash', async () => {
    const { BundleStore } = await import('../assets/BundleStore');
    const { hashBlob }    = await import('../assets/BundleHasher');
    const { decodeSaveZip } = await import('./SaveFile');
    const blob = new Blob([new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF])]);
    const hash = await hashBlob(blob);
    const store = new BundleStore();
    store.put(hash, blob);
    const manifest: AssetEntry[] = [
      { slug: 'custom:a', name: 'A', type: 'image', url: '', preload: false, bundled: true, hash, size: 4 },
      { slug: 'custom:b', name: 'B', type: 'image', url: '', preload: false, bundled: true, hash, size: 4 },
    ];
    await downloadSceneFile([], null, manifest, undefined, undefined, store);
    const [zipBlob] = downloadMock.mock.calls[0] as [Blob, string];
    const bytes     = new Uint8Array(await zipBlob.arrayBuffer());
    const decoded   = await decodeSaveZip(bytes);
    expect(decoded.blobs.length).toBe(1);
    expect(decoded.blobs[0].hash).toBe(hash);
  });

  test('skips bundled entries whose hash is missing from BundleStore', async () => {
    const { BundleStore } = await import('../assets/BundleStore');
    const { decodeSaveZip } = await import('./SaveFile');
    const manifest: AssetEntry[] = [
      { slug: 'custom:missing', name: 'M', type: 'image', url: '', preload: false, bundled: true, hash: 'f'.repeat(64), size: 1234 },
    ];
    await downloadSceneFile([], null, manifest, undefined, undefined, new BundleStore());
    const [zipBlob] = downloadMock.mock.calls[0] as [Blob, string];
    const bytes     = new Uint8Array(await zipBlob.arrayBuffer());
    const decoded   = await decodeSaveZip(bytes);
    expect(decoded.blobs).toEqual([]);
  });
});

import { describe, test, expect } from 'vitest';
import {
  SAVE_FORMAT,
  SAVE_VERSION,
  encodeSaveFile,
  decodeSaveFile,
  encodeSaveZip,
  decodeSaveZip,
  looksLikeSaveZip,
  defaultSaveFilename,
  SaveFileError,
} from './SaveFile';
import { type EntitySerialized } from './Scene';
import { registerCorePrimitives } from './spawnables';

registerCorePrimitives();

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

describe('SaveFile.encode', () => {
  test('produces an envelope with expected fields', () => {
    const env = encodeSaveFile({ scene: sampleScene, thumbnail: null, savedAt: '2026-05-06T12:00:00.000Z' });
    expect(env.format).toBe(SAVE_FORMAT);
    expect(env.version).toBe(SAVE_VERSION);
    expect(env.savedAt).toBe('2026-05-06T12:00:00.000Z');
    expect(env.thumbnail).toBeNull();
    expect(env.scene).toEqual(sampleScene);
    expect(env.script).toEqual({ source: '', initialised: false });
    expect(env.manifest).toEqual([]);
  });

  test('carries the supplied manifest through', () => {
    const entry = { slug: 'custom:m', name: 'M', type: 'image' as const, url: 'http://x', preload: true };
    const env   = encodeSaveFile({ scene: [], thumbnail: null, manifest: [entry] });
    expect(env.manifest).toEqual([entry]);
  });

  test('defaults savedAt to current ISO timestamp', () => {
    const env = encodeSaveFile({ scene: [], thumbnail: null });
    expect(typeof env.savedAt).toBe('string');
    expect(env.savedAt.length).toBeGreaterThan(0);
  });

  test('carries the supplied script through', () => {
    const env = encodeSaveFile({
      scene:     [],
      thumbnail: null,
      script:    { source: 'export default class extends Game {}', initialised: true },
    });
    expect(env.script).toEqual({ source: 'export default class extends Game {}', initialised: true });
  });
});

describe('SaveFile round-trip', () => {
  test('encode → JSON → decode preserves the scene', () => {
    const env = encodeSaveFile({
      scene:     sampleScene,
      thumbnail: 'data:image/png;base64,iVBORw0KGgo=',
      savedAt:   '2026-05-06T12:00:00.000Z',
    });
    const text    = JSON.stringify(env);
    const decoded = decodeSaveFile(text);
    expect(decoded.scene).toEqual(sampleScene);
    expect(decoded.thumbnail).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(decoded.savedAt).toBe('2026-05-06T12:00:00.000Z');
  });

  test('encode → JSON → decode preserves the script slot', () => {
    const env = encodeSaveFile({
      scene:     [],
      thumbnail: null,
      script:    { source: 'src here', initialised: true },
    });
    const decoded = decodeSaveFile(JSON.stringify(env));
    expect(decoded.script).toEqual({ source: 'src here', initialised: true });
  });

  test('decode tolerates missing optional fields', () => {
    const text = JSON.stringify({
      format:  SAVE_FORMAT,
      version: SAVE_VERSION,
      scene:   [],
    });
    const decoded = decodeSaveFile(text);
    expect(decoded.thumbnail).toBeNull();
    expect(decoded.savedAt).toBe('');
    expect(decoded.scene).toEqual([]);
    // Pre-scripting saves carry no `script` field — decode treats as empty.
    expect(decoded.script).toEqual({ source: '', initialised: false });
    // Pre-asset-system saves carry no `manifest` field — decode treats as empty.
    expect(decoded.manifest).toEqual([]);
  });

  test('encode → JSON → decode preserves a populated manifest', () => {
    const entry = { slug: 'custom:m', name: 'M', type: 'image' as const, url: 'http://x', preload: true, tags: ['face'] };
    const env   = encodeSaveFile({ scene: [], thumbnail: null, manifest: [entry] });
    const decoded = decodeSaveFile(JSON.stringify(env));
    expect(decoded.manifest).toEqual([entry]);
  });

  test('decode tolerates a null script (older draft)', () => {
    const text = JSON.stringify({
      format:  SAVE_FORMAT,
      version: SAVE_VERSION,
      scene:   [],
      script:  null,
    });
    const decoded = decodeSaveFile(text);
    expect(decoded.script).toEqual({ source: '', initialised: false });
  });

  test('encode → JSON → decode preserves turn state', () => {
    const turns = {
      enabled:    true,
      order:      [2, 0, 1] as never,
      activeSeat: 2 as never,
      turnNumber: 7,
      orderIndex: 0,
    };
    const env = encodeSaveFile({ scene: [], thumbnail: null, turns });
    const decoded = decodeSaveFile(JSON.stringify(env));
    expect(decoded.turns).toEqual(turns);
  });

  test('decode tolerates a missing turns field (pre-turn-tracker save)', () => {
    const text = JSON.stringify({
      format:  SAVE_FORMAT,
      version: SAVE_VERSION,
      scene:   [],
    });
    const decoded = decodeSaveFile(text);
    expect(decoded.turns.enabled).toBe(false);
    expect(decoded.turns.activeSeat).toBeNull();
    expect(decoded.turns.turnNumber).toBe(0);
    expect(decoded.turns.order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('SaveFile.decode validation', () => {
  test('rejects invalid JSON', () => {
    expect(() => decodeSaveFile('not json')).toThrow(SaveFileError);
  });

  test('rejects unknown format', () => {
    const text = JSON.stringify({ format: 'other', version: 1, scene: [] });
    expect(() => decodeSaveFile(text)).toThrow(/format/i);
  });

  test('rejects unknown version', () => {
    const text = JSON.stringify({ format: SAVE_FORMAT, version: 99, scene: [] });
    expect(() => decodeSaveFile(text)).toThrow(/version/i);
  });

  test('rejects missing scene', () => {
    const text = JSON.stringify({ format: SAVE_FORMAT, version: 1 });
    expect(() => decodeSaveFile(text)).toThrow(/scene/i);
  });

  test('rejects unknown component typeId', () => {
    const bad: EntitySerialized = {
      id:            'd-1',
      type:          'die',
      name:          'Die',
      tags:          [],
      owner:         null,
      privateToSeat: null,
      parentId:      null,
      children:      [],
      components: { unknownComponent: {} },
    };
    const text = JSON.stringify({ format: SAVE_FORMAT, version: 1, scene: [bad] });
    expect(() => decodeSaveFile(text)).toThrow(/unknown component/i);
  });

  test('rejects non-object root', () => {
    expect(() => decodeSaveFile('[]')).toThrow(SaveFileError);
  });

  test('rejects malformed script (string)', () => {
    const text = JSON.stringify({
      format:  SAVE_FORMAT,
      version: SAVE_VERSION,
      scene:   [],
      script:  'not an object',
    });
    expect(() => decodeSaveFile(text)).toThrow(/script/i);
  });

  test('rejects malformed script.source', () => {
    const text = JSON.stringify({
      format:  SAVE_FORMAT,
      version: SAVE_VERSION,
      scene:   [],
      script:  { source: 42, initialised: false },
    });
    expect(() => decodeSaveFile(text)).toThrow(/source/i);
  });

  test('rejects malformed script.initialised', () => {
    const text = JSON.stringify({
      format:  SAVE_FORMAT,
      version: SAVE_VERSION,
      scene:   [],
      script:  { source: '', initialised: 'yes' },
    });
    expect(() => decodeSaveFile(text)).toThrow(/initialised/i);
  });

  test('rejects malformed manifest (not an array)', () => {
    const text = JSON.stringify({ format: SAVE_FORMAT, version: SAVE_VERSION, scene: [], manifest: 'oops' });
    expect(() => decodeSaveFile(text)).toThrow(/manifest/i);
  });

  test('rejects manifest entry with bad slug', () => {
    const text = JSON.stringify({
      format:   SAVE_FORMAT,
      version:  SAVE_VERSION,
      scene:    [],
      manifest: [{ slug: 'BadSlug', name: 'X', type: 'image', url: '', preload: false }],
    });
    expect(() => decodeSaveFile(text)).toThrow(/slug/i);
  });

  test('rejects manifest entry with unknown type', () => {
    const text = JSON.stringify({
      format:   SAVE_FORMAT,
      version:  SAVE_VERSION,
      scene:    [],
      manifest: [{ slug: 'custom:x', name: 'X', type: 'sprite', url: '', preload: false }],
    });
    expect(() => decodeSaveFile(text)).toThrow(/type/i);
  });

  test('rejects manifest with duplicate slugs', () => {
    const e = { slug: 'custom:x', name: 'X', type: 'image', url: '', preload: false };
    const text = JSON.stringify({ format: SAVE_FORMAT, version: SAVE_VERSION, scene: [], manifest: [e, e] });
    expect(() => decodeSaveFile(text)).toThrow(/duplicate/i);
  });
});

describe('defaultSaveFilename', () => {
  test('defaults to the .boardtogether v2 extension', () => {
    expect(defaultSaveFilename('2026-05-06T12:00:00.000Z')).toBe('vtt-scene-2026-05-06.boardtogether');
  });

  test('accepts a legacy .json extension override', () => {
    expect(defaultSaveFilename('2026-05-06T12:00:00.000Z', 'json')).toBe('vtt-scene-2026-05-06.json');
  });

  test('falls back when timestamp is empty', () => {
    expect(defaultSaveFilename('')).toBe('vtt-scene-unknown.boardtogether');
  });
});

describe('SaveFile zip round-trip', () => {
  test('encode → decode preserves the envelope and zero-bundle blobs', async () => {
    const envelope = encodeSaveFile({
      scene:     [],
      thumbnail: null,
      savedAt:   '2026-05-06T12:00:00.000Z',
    });
    const blob   = await encodeSaveZip(envelope, []);
    const bytes  = new Uint8Array(await blob.arrayBuffer());
    expect(looksLikeSaveZip(bytes)).toBe(true);
    const decoded = await decodeSaveZip(bytes);
    expect(decoded.envelope.scene).toEqual([]);
    expect(decoded.envelope.version).toBe(SAVE_VERSION);
    expect(decoded.blobs).toEqual([]);
  });

  test('encode → decode preserves manifest-referenced blobs by hash', async () => {
    const { hashBlob } = await import('../assets/BundleHasher');
    const blob1    = new Blob([new Uint8Array([1, 2, 3])]);
    const blob2    = new Blob([new Uint8Array([4, 5, 6, 7])]);
    const hash1    = await hashBlob(blob1);
    const hash2    = await hashBlob(blob2);
    const envelope = encodeSaveFile({
      scene:    [],
      thumbnail: null,
      manifest: [
        { slug: 'custom:a', name: 'A', type: 'image', url: '', preload: false, bundled: true, hash: hash1, size: 3 },
        { slug: 'custom:b', name: 'B', type: 'sound', url: '', preload: false, bundled: true, hash: hash2, size: 4 },
      ],
    });
    const zipBlob  = await encodeSaveZip(envelope, [
      { hash: hash1, blob: blob1 },
      { hash: hash2, blob: blob2 },
    ]);
    const bytes   = new Uint8Array(await zipBlob.arrayBuffer());
    const decoded = await decodeSaveZip(bytes);
    expect(decoded.blobs.length).toBe(2);
    const byHash = new Map(decoded.blobs.map(b => [b.hash, b.blob]));
    expect(Array.from(new Uint8Array(await byHash.get(hash1)!.arrayBuffer())))
      .toEqual([1, 2, 3]);
    expect(Array.from(new Uint8Array(await byHash.get(hash2)!.arrayBuffer())))
      .toEqual([4, 5, 6, 7]);
  });

  test('decodeSaveZip skips orphan blobs not referenced by manifest', async () => {
    const { hashBlob } = await import('../assets/BundleHasher');
    const orphan = new Blob([new Uint8Array([9, 9, 9])]);
    const orphanHash = await hashBlob(orphan);
    // Manifest is empty — the blob has no manifest entry referencing it.
    const envelope = encodeSaveFile({ scene: [], thumbnail: null });
    const zipBlob  = await encodeSaveZip(envelope, [{ hash: orphanHash, blob: orphan }]);
    const bytes    = new Uint8Array(await zipBlob.arrayBuffer());
    const decoded  = await decodeSaveZip(bytes);
    expect(decoded.blobs).toEqual([]);
  });

  test('decodeSaveZip rejects on hash mismatch for a referenced blob', async () => {
    // Manifest references a hash, but the zip's bytes hash to something else.
    const claimedHash = 'a'.repeat(64);
    const envelope = encodeSaveFile({
      scene:    [],
      thumbnail: null,
      manifest: [
        { slug: 'custom:tampered', name: 'T', type: 'image', url: '', preload: false, bundled: true, hash: claimedHash, size: 5 },
      ],
    });
    const bytes   = new Uint8Array(await (await encodeSaveZip(envelope, [
      { hash: claimedHash, blob: new Blob([new Uint8Array([1, 2, 3, 4, 5])]) },
    ])).arrayBuffer());
    await expect(decodeSaveZip(bytes)).rejects.toThrow(/hash mismatch/i);
  });

  test('decodeSaveZip rejects an envelope with unknown component typeId', async () => {
    // Build a v2 envelope by hand with a bad component. encodeSaveFile would
    // accept anything (it doesn't validate), so we synth the zip directly.
    const bad: EntitySerialized = {
      id: 'x-1', type: 'x', name: 'X', tags: [], owner: null,
      privateToSeat: null, parentId: null, children: [],
      components: { unknownComponent: {} },
    };
    const envelope = encodeSaveFile({ scene: [bad], thumbnail: null });
    const blob = await encodeSaveZip(envelope, []);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await expect(decodeSaveZip(bytes)).rejects.toThrow(/unknown component/i);
  });
});

describe('decodeSaveFile accepts both v1 and v2 versions', () => {
  test('v1 envelope decodes (pre-zip JSON saves still load)', () => {
    const text    = JSON.stringify({ format: SAVE_FORMAT, version: 1, scene: [] });
    const decoded = decodeSaveFile(text);
    expect(decoded.version).toBe(1);
    expect(decoded.scene).toEqual([]);
  });

  test('v2 envelope decodes', () => {
    const text    = JSON.stringify({ format: SAVE_FORMAT, version: 2, scene: [] });
    const decoded = decodeSaveFile(text);
    expect(decoded.version).toBe(2);
  });
});

describe('looksLikeSaveZip', () => {
  test('returns true for a zipped envelope', async () => {
    const env  = encodeSaveFile({ scene: [], thumbnail: null });
    const zip  = await encodeSaveZip(env, []);
    const u8   = new Uint8Array(await zip.arrayBuffer());
    expect(looksLikeSaveZip(u8)).toBe(true);
  });

  test('returns false for raw JSON envelope bytes', () => {
    const env  = encodeSaveFile({ scene: [], thumbnail: null });
    const u8   = new TextEncoder().encode(JSON.stringify(env));
    expect(looksLikeSaveZip(u8)).toBe(false);
  });
});

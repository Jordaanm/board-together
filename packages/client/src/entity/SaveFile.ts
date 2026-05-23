// Save-file envelope for the host's scene (PRD § Save / Load).
//
// Single JSON document with shape `{ format, version, savedAt, thumbnail,
// scene, script }`. `format` is the sentinel `"vtt-scene"`; `version` is an
// integer starting at 1; `scene` is the existing `EntitySerialized[]` shape
// produced by `World.snapshot`. `thumbnail` is a lossless PNG data URL (so
// the future steganography path can embed the save payload in the pixels
// without JPEG resampling corrupting it); `savedAt` is an ISO timestamp;
// `script` carries the host's authored script source plus its `initialised`
// flag (issues--scripting-v1.md §2).
//
// Validation on `decode` rejects unknown `format`, unknown `version`, missing
// required fields, or any unknown component `typeId` in `scene`. Optional
// fields (`thumbnail`, `savedAt`, `script`) are tolerated when absent — a
// missing `script` is treated as `{ source: '', initialised: false }` so
// pre-scripting save files keep loading.

import { type EntitySerialized } from './Scene';
import { componentRegistry } from './ComponentRegistry';
import { type AssetEntry, type AssetType, validateSlug } from '../assets/Manifest';
import { initialTurnState, type TurnState } from '../seats/TurnTracker';
import { type SeatIndex } from '../seats/SeatLayout';
import { encodeZip, decodeZip, looksLikeZip } from './saveZip';
import { hashBlob } from '../assets/BundleHasher';

export const SAVE_FORMAT             = 'vtt-scene';
export const SAVE_VERSION            = 2;
// Versions accepted on read. v1 is the pre-bundled-assets JSON-only format;
// v2 is the always-zip envelope. Both decode to the same SaveEnvelope shape.
export const SUPPORTED_SAVE_VERSIONS = [1, 2] as const;

const ASSET_TYPES: ReadonlySet<AssetType> = new Set(['image', 'model', 'sound', 'spritesheet', 'pdf']);

export interface SavedScript {
  source:      string;
  initialised: boolean;
}

export const EMPTY_SCRIPT: SavedScript = { source: '', initialised: false };

export type SaveVersion = (typeof SUPPORTED_SAVE_VERSIONS)[number];

export interface SaveEnvelope {
  format:    typeof SAVE_FORMAT;
  version:   SaveVersion;
  savedAt:   string;
  thumbnail: string | null;
  scene:     EntitySerialized[];
  script:    SavedScript;
  manifest:  AssetEntry[];
  // Turn-tracker state at save-time. Omitted from pre-turn-tracker save files;
  // `decodeSaveFile` substitutes a default state in that case so old saves
  // continue to load.
  turns:     TurnState;
}

export interface EncodeOptions {
  scene:     readonly EntitySerialized[];
  thumbnail: string | null;
  savedAt?:  string;  // defaults to new Date().toISOString()
  script?:   SavedScript;
  manifest?: readonly AssetEntry[];
  turns?:    TurnState;
}

export function encodeSaveFile(opts: EncodeOptions): SaveEnvelope {
  return {
    format:    SAVE_FORMAT,
    version:   SAVE_VERSION,
    savedAt:   opts.savedAt ?? new Date().toISOString(),
    thumbnail: opts.thumbnail,
    scene:     [...opts.scene],
    script:    opts.script ?? { ...EMPTY_SCRIPT },
    manifest:  opts.manifest ? opts.manifest.map(cloneAssetEntry) : [],
    turns:     opts.turns ? cloneTurnState(opts.turns) : initialTurnState(),
  };
}

export class SaveFileError extends Error {}

// Parses a JSON string and validates the envelope. Throws SaveFileError with
// a human-readable message on any validation failure; never returns partially
// decoded state. Consumers display the message in an error modal.
export function decodeSaveFile(text: string): SaveEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new SaveFileError('File is not valid JSON.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SaveFileError('File is not a save envelope.');
  }
  const obj = raw as Record<string, unknown>;

  if (obj.format !== SAVE_FORMAT) {
    throw new SaveFileError(`Unknown save format: ${JSON.stringify(obj.format)}`);
  }
  if (!SUPPORTED_SAVE_VERSIONS.includes(obj.version as SaveVersion)) {
    throw new SaveFileError(`Unsupported save version: ${JSON.stringify(obj.version)}`);
  }
  const version = obj.version as SaveVersion;
  if (!Array.isArray(obj.scene)) {
    throw new SaveFileError('Save file is missing required field "scene".');
  }

  const scene = obj.scene.map((e, i) => validateEntitySerialized(e, i));

  const thumbnail = obj.thumbnail === undefined ? null
    : typeof obj.thumbnail === 'string' ? obj.thumbnail
    : obj.thumbnail === null            ? null
    : (() => { throw new SaveFileError('Field "thumbnail" must be a string or null.'); })();

  const savedAt = obj.savedAt === undefined ? ''
    : typeof obj.savedAt === 'string'    ? obj.savedAt
    : (() => { throw new SaveFileError('Field "savedAt" must be a string.'); })();

  return {
    format:    SAVE_FORMAT,
    version,
    savedAt,
    thumbnail,
    scene,
    script:    decodeScript(obj.script),
    manifest:  decodeManifest(obj.manifest),
    turns:     decodeTurns(obj.turns),
  };
}

function decodeTurns(raw: unknown): TurnState {
  if (raw === undefined || raw === null) return initialTurnState();
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SaveFileError('Field "turns" must be an object.');
  }
  const t = raw as Record<string, unknown>;
  if (typeof t.enabled !== 'boolean') {
    throw new SaveFileError('Field "turns.enabled" must be a boolean.');
  }
  if (!Array.isArray(t.order) || t.order.some(v => typeof v !== 'number')) {
    throw new SaveFileError('Field "turns.order" must be a number array.');
  }
  if (t.activeSeat !== null && typeof t.activeSeat !== 'number') {
    throw new SaveFileError('Field "turns.activeSeat" must be a number or null.');
  }
  if (typeof t.turnNumber !== 'number') {
    throw new SaveFileError('Field "turns.turnNumber" must be a number.');
  }
  // orderIndex is optional for forward compatibility with envelopes encoded
  // before the field was tracked. Default to -1 so the next next() wraps to
  // order[0] — the natural "off-order" fallback.
  const orderIndex = t.orderIndex === undefined ? -1
    : typeof t.orderIndex === 'number' ? t.orderIndex
    : (() => { throw new SaveFileError('Field "turns.orderIndex" must be a number.'); })();
  return {
    enabled:    t.enabled,
    order:      [...(t.order as number[])] as SeatIndex[],
    activeSeat: t.activeSeat as SeatIndex | null,
    turnNumber: t.turnNumber,
    orderIndex,
  };
}

function cloneTurnState(t: TurnState): TurnState {
  return {
    enabled:    t.enabled,
    order:      [...t.order],
    activeSeat: t.activeSeat,
    turnNumber: t.turnNumber,
    orderIndex: t.orderIndex,
  };
}

function decodeManifest(raw: unknown): AssetEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new SaveFileError('Field "manifest" must be an array.');
  }
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new SaveFileError(`manifest[${i}] is not an object.`);
    }
    const e = entry as Record<string, unknown>;
    const slugCheck = validateSlug(e.slug);
    if (!slugCheck.ok) throw new SaveFileError(`manifest[${i}].slug invalid: ${slugCheck.error}`);
    const slug = e.slug as string;
    if (seen.has(slug)) throw new SaveFileError(`manifest[${i}] duplicate slug "${slug}".`);
    seen.add(slug);
    if (typeof e.name !== 'string' || e.name.length === 0) {
      throw new SaveFileError(`manifest[${i}].name must be a non-empty string.`);
    }
    if (typeof e.type !== 'string' || !ASSET_TYPES.has(e.type as AssetType)) {
      throw new SaveFileError(`manifest[${i}].type must be one of image|model|sound|spritesheet.`);
    }
    if (typeof e.url !== 'string') {
      throw new SaveFileError(`manifest[${i}].url must be a string.`);
    }
    if (typeof e.preload !== 'boolean') {
      throw new SaveFileError(`manifest[${i}].preload must be a boolean.`);
    }
    if (e.description !== undefined && typeof e.description !== 'string') {
      throw new SaveFileError(`manifest[${i}].description must be a string.`);
    }
    if (e.tags !== undefined) {
      if (!Array.isArray(e.tags) || e.tags.some(t => typeof t !== 'string')) {
        throw new SaveFileError(`manifest[${i}].tags must be a string array.`);
      }
    }
    if (e.type === 'spritesheet') {
      if (typeof e.cols !== 'number' || !Number.isInteger(e.cols) || e.cols < 1) {
        throw new SaveFileError(`manifest[${i}].cols must be a positive integer.`);
      }
      if (typeof e.rows !== 'number' || !Number.isInteger(e.rows) || e.rows < 1) {
        throw new SaveFileError(`manifest[${i}].rows must be a positive integer.`);
      }
    }
    if (e.type === 'pdf') {
      if (e.aspectRatio !== undefined &&
          (typeof e.aspectRatio !== 'number' || !Number.isFinite(e.aspectRatio) || e.aspectRatio <= 0)) {
        throw new SaveFileError(`manifest[${i}].aspectRatio must be a positive finite number.`);
      }
      if (e.pageCount !== undefined &&
          (typeof e.pageCount !== 'number' || !Number.isInteger(e.pageCount) || e.pageCount < 1)) {
        throw new SaveFileError(`manifest[${i}].pageCount must be a positive integer.`);
      }
    }
    if (e.bundled !== undefined && typeof e.bundled !== 'boolean') {
      throw new SaveFileError(`manifest[${i}].bundled must be a boolean.`);
    }
    if (e.hash !== undefined && typeof e.hash !== 'string') {
      throw new SaveFileError(`manifest[${i}].hash must be a string.`);
    }
    if (e.size !== undefined && (typeof e.size !== 'number' || !Number.isInteger(e.size) || e.size < 0)) {
      throw new SaveFileError(`manifest[${i}].size must be a non-negative integer.`);
    }
    if (e.bundled === true) {
      if (typeof e.hash !== 'string' || !/^[a-f0-9]{64}$/.test(e.hash)) {
        throw new SaveFileError(`manifest[${i}].hash must be 64 lowercase hex chars when bundled.`);
      }
      if (typeof e.size !== 'number') {
        throw new SaveFileError(`manifest[${i}].size is required when bundled.`);
      }
    } else {
      if (e.hash !== undefined) {
        throw new SaveFileError(`manifest[${i}].hash is only valid on bundled entries.`);
      }
      if (e.size !== undefined) {
        throw new SaveFileError(`manifest[${i}].size is only valid on bundled entries.`);
      }
    }
    return {
      slug,
      name:        e.name,
      type:        e.type as AssetType,
      url:         e.url,
      preload:     e.preload,
      description: e.description as string | undefined,
      tags:        e.tags ? [...(e.tags as string[])] : undefined,
      ...(e.type === 'spritesheet' ? { cols: e.cols as number, rows: e.rows as number } : {}),
      ...(e.type === 'pdf' && e.aspectRatio !== undefined ? { aspectRatio: e.aspectRatio as number } : {}),
      ...(e.type === 'pdf' && e.pageCount   !== undefined ? { pageCount:   e.pageCount   as number } : {}),
      ...(e.bundled === true ? { bundled: true, hash: e.hash as string, size: e.size as number } : {}),
    };
  });
}

function cloneAssetEntry(e: AssetEntry): AssetEntry {
  return {
    slug:        e.slug,
    name:        e.name,
    type:        e.type,
    url:         e.url,
    preload:     e.preload,
    description: e.description,
    tags:        e.tags ? [...e.tags] : undefined,
    cols:        e.cols,
    rows:        e.rows,
    bundled:     e.bundled,
    hash:        e.hash,
    size:        e.size,
  };
}

function decodeScript(raw: unknown): SavedScript {
  if (raw === undefined || raw === null) return { ...EMPTY_SCRIPT };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SaveFileError('Field "script" must be an object.');
  }
  const s = raw as Record<string, unknown>;
  const source = s.source ?? '';
  if (typeof source !== 'string') {
    throw new SaveFileError('Field "script.source" must be a string.');
  }
  const initialised = s.initialised ?? false;
  if (typeof initialised !== 'boolean') {
    throw new SaveFileError('Field "script.initialised" must be a boolean.');
  }
  return { source, initialised };
}

function validateEntitySerialized(raw: unknown, index: number): EntitySerialized {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SaveFileError(`scene[${index}] is not an object.`);
  }
  const e = raw as Record<string, unknown>;
  if (typeof e.id   !== 'string') throw new SaveFileError(`scene[${index}].id must be a string.`);
  if (typeof e.type !== 'string') throw new SaveFileError(`scene[${index}].type must be a string.`);
  if (typeof e.name !== 'string') throw new SaveFileError(`scene[${index}].name must be a string.`);
  if (!e.components || typeof e.components !== 'object' || Array.isArray(e.components)) {
    throw new SaveFileError(`scene[${index}].components must be an object.`);
  }
  for (const typeId of Object.keys(e.components as Record<string, unknown>)) {
    if (!componentRegistry.get(typeId)) {
      throw new SaveFileError(`scene[${index}] references unknown component "${typeId}".`);
    }
  }
  return e as unknown as EntitySerialized;
}

// One bundled-asset blob written into / read out of a v2 save zip. The
// `hash` is the SHA-256 hex string used as the filename inside `assets/`.
export interface SaveZipBundle {
  hash: string;
  blob: Blob;
}

// Encode a v2 save: STORED zip with `scene.json` (the envelope) plus one
// `assets/<hash>` entry per bundle. Returns the on-disk Blob ready for
// download. With an empty `bundles` array the zip is ~200 bytes — just the
// envelope plus zip headers.
export async function encodeSaveZip(
  envelope: SaveEnvelope,
  bundles:  ReadonlyArray<SaveZipBundle>,
): Promise<Blob> {
  const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));
  const blobBytes     = await Promise.all(
    bundles.map(async (b) => ({ name: b.hash, bytes: new Uint8Array(await b.blob.arrayBuffer()) })),
  );
  const zip = await encodeZip(envelopeBytes, blobBytes);
  return new Blob([zip], { type: 'application/zip' });
}

// Decode a v2 save zip. Validates the envelope via decodeSaveFile, then:
//   - Filters blobs to those referenced by a `bundled` manifest entry —
//     orphans are silently dropped (defensive against malformed zips).
//   - Hash-verifies each surviving blob: filename must equal the SHA-256
//     of the actual bytes. Mismatch → reject the load with SaveFileError
//     so no partial state ever reaches the host.
//
// Returns the verified set ready for the caller to pump into BundleStore
// + BundleCache.
export async function decodeSaveZip(bytes: Uint8Array): Promise<{
  envelope: SaveEnvelope;
  blobs:    SaveZipBundle[];
}> {
  const { envelopeBytes, blobs } = await decodeZip(bytes);
  const text     = new TextDecoder().decode(envelopeBytes);
  const envelope = decodeSaveFile(text);

  const referenced = new Set<string>();
  for (const e of envelope.manifest) {
    if (e.bundled === true && typeof e.hash === 'string') referenced.add(e.hash);
  }

  const verified: SaveZipBundle[] = [];
  for (const b of blobs) {
    if (!referenced.has(b.name)) continue; // orphan, skip
    const blob       = new Blob([b.bytes]);
    const actualHash = await hashBlob(blob);
    if (actualHash !== b.name) {
      throw new SaveFileError(
        `Bundle hash mismatch for ${b.name}: bytes hash to ${actualHash}`,
      );
    }
    verified.push({ hash: b.name, blob });
  }
  return { envelope, blobs: verified };
}

// Re-export so callers can sniff bytes without importing from saveZip.
export { looksLikeZip as looksLikeSaveZip };

// Browser-only download helper: trigger an anchor click against a Blob URL.
export function downloadSaveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Default filename uses `.boardtogether` (the v2 zip format) unless the
// caller asks for a different extension (used by tests that exercise the
// legacy JSON v1 read path).
export function defaultSaveFilename(isoTimestamp: string, ext: 'boardtogether' | 'json' = 'boardtogether'): string {
  const dateOnly = isoTimestamp.slice(0, 10);  // YYYY-MM-DD
  return `vtt-scene-${dateOnly || 'unknown'}.${ext}`;
}

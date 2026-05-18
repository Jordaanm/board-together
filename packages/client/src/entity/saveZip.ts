// On-disk save-file zip codec. Pure: knows the layout (`scene.json` at root,
// blobs under `assets/<name>`) but nothing about AssetEntry or the manifest.
// All entries are STORED (no deflate) — bundled media is already compressed,
// and STORED keeps decode O(n) with minimal CPU.
//
// The async wrappers return Promises so callers can `await` regardless of
// whether the underlying fflate implementation runs sync or off-thread. The
// current implementation uses the sync API because the envelope+blobs are
// already in memory; if a future slice moves to streamed I/O the public
// signature here is stable.

import { unzipSync, zipSync } from 'fflate';

export interface BundleZipBlob {
  name:  string;     // filename under `assets/`; SHA-256 hex in practice
  bytes: Uint8Array;
}

export interface DecodedSaveZip {
  envelopeBytes: Uint8Array;
  blobs:         BundleZipBlob[];
}

export class SaveZipError extends Error {}

const SCENE_ENTRY    = 'scene.json';
const ASSETS_PREFIX  = 'assets/';
const ZIP_MAGIC      = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04"

export function looksLikeZip(bytes: Uint8Array): boolean {
  if (bytes.length < ZIP_MAGIC.length) return false;
  for (let i = 0; i < ZIP_MAGIC.length; i++) {
    if (bytes[i] !== ZIP_MAGIC[i]) return false;
  }
  return true;
}

export async function encodeZip(
  envelopeBytes: Uint8Array,
  blobs:         ReadonlyArray<BundleZipBlob>,
): Promise<Uint8Array> {
  // STORED (level 0) — already-compressed media wins nothing from deflate.
  const input: Record<string, [Uint8Array, { level: 0 }]> = {
    [SCENE_ENTRY]: [envelopeBytes, { level: 0 }],
  };
  for (const b of blobs) {
    input[`${ASSETS_PREFIX}${b.name}`] = [b.bytes, { level: 0 }];
  }
  return zipSync(input, { level: 0 });
}

export async function decodeZip(bytes: Uint8Array): Promise<DecodedSaveZip> {
  if (!looksLikeZip(bytes)) {
    throw new SaveZipError('Input is not a zip file (missing PK signature).');
  }
  let unpacked;
  try {
    unpacked = unzipSync(bytes);
  } catch (e) {
    throw new SaveZipError(`Zip is malformed: ${(e as Error).message}`);
  }
  // Some Windows zip tools (PowerShell Compress-Archive) emit backslashes
  // in entry paths even though APPNOTE 4.4.17.1 requires forward slashes.
  // Normalise so a host who round-trips through OS tools doesn't break load.
  const normalised: Record<string, Uint8Array> = {};
  for (const [path, b] of Object.entries(unpacked)) {
    normalised[path.replace(/\\/g, '/')] = b;
  }
  const envelopeBytes = normalised[SCENE_ENTRY];
  if (!envelopeBytes) {
    throw new SaveZipError(`Zip is missing required entry "${SCENE_ENTRY}".`);
  }
  const blobs: BundleZipBlob[] = [];
  for (const [path, b] of Object.entries(normalised)) {
    if (path === SCENE_ENTRY) continue;
    if (!path.startsWith(ASSETS_PREFIX)) continue;       // ignore stray entries
    const name = path.slice(ASSETS_PREFIX.length);
    if (name.length === 0) continue;                     // skip the bare dir entry
    blobs.push({ name, bytes: b });
  }
  return { envelopeBytes, blobs };
}

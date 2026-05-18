// Pure save-flow utility extracted from ThreeCanvas's `saveSceneRef` body.
// Encodes the host's snapshot + thumbnail + script + manifest + turns into
// the v2 zip envelope (.boardtogether) and triggers the browser download.
// Renderer concerns (capturing the thumbnail) stay in the caller — this
// helper is decoupled from WebGL so panels can compose it directly.
//
// Bundled-asset payload bytes come straight from the BundleStore by hash;
// the manifest defines what to include, the store defines the bytes. Saves
// with no bundled entries produce a zip that's ~200B larger than the legacy
// JSON envelope (just the zip overhead).

import { type EntitySerialized } from './Scene';
import { type AssetEntry } from '../assets/Manifest';
import { type BundleStore } from '../assets/BundleStore';
import {
  encodeSaveFile,
  encodeSaveZip,
  downloadSaveBlob,
  defaultSaveFilename,
  type SavedScript,
  type SaveZipBundle,
} from './SaveFile';
import { type TurnState } from '../seats/TurnTracker';

export async function downloadSceneFile(
  snapshot:    readonly EntitySerialized[],
  thumbnail:   string | null,
  manifest:    readonly AssetEntry[],
  script:      SavedScript | undefined,
  turns?:      TurnState,
  bundleStore?: BundleStore,
): Promise<void> {
  const envelope = encodeSaveFile({
    scene: snapshot,
    thumbnail,
    manifest,
    script,
    turns,
  });
  const bundles = bundleStore ? collectBundles(manifest, bundleStore) : [];
  const blob    = await encodeSaveZip(envelope, bundles);
  downloadSaveBlob(blob, defaultSaveFilename(envelope.savedAt));
}

// Walk the manifest, dedupe by hash, and pull each bundle's bytes from the
// BundleStore. Entries that are bundled but missing from the store (e.g.
// host cleared IndexedDB) are skipped — the zip will be missing them and a
// subsequent load will mark those slugs broken on resolve.
function collectBundles(
  manifest:    readonly AssetEntry[],
  bundleStore: BundleStore,
): SaveZipBundle[] {
  const seen: Set<string> = new Set();
  const out:  SaveZipBundle[] = [];
  for (const e of manifest) {
    if (e.bundled !== true || typeof e.hash !== 'string') continue;
    if (seen.has(e.hash)) continue;
    const blob = bundleStore.get(e.hash);
    if (!blob) continue;
    seen.add(e.hash);
    out.push({ hash: e.hash, blob });
  }
  return out;
}

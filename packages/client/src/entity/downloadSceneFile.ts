// Pure save-flow utility extracted from ThreeCanvas's `saveSceneRef` body.
// Encodes the host's snapshot + thumbnail + script + manifest + turns into
// the v2 zip envelope (.boardtogether) and triggers the browser download.
// Renderer concerns (capturing the thumbnail) stay in the caller — this
// helper is decoupled from WebGL so panels can compose it directly.
//
// Bundle payload bytes (`assets/<hash>`) are wired in by issue #8 — for now
// the zip contains only `scene.json` (~200B overhead vs the legacy JSON).

import { type EntitySerialized } from './Scene';
import { type AssetEntry } from '../assets/Manifest';
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
  snapshot:  readonly EntitySerialized[],
  thumbnail: string | null,
  manifest:  readonly AssetEntry[],
  script:    SavedScript | undefined,
  turns?:    TurnState,
  bundles:   ReadonlyArray<SaveZipBundle> = [],
): Promise<void> {
  const envelope = encodeSaveFile({
    scene: snapshot,
    thumbnail,
    manifest,
    script,
    turns,
  });
  const blob = await encodeSaveZip(envelope, bundles);
  downloadSaveBlob(blob, defaultSaveFilename(envelope.savedAt));
}

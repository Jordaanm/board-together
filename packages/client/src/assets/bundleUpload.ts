// Pure helpers for the host's Asset Manager upload flows. Two paths:
//
//   - Local file → hash → BundleStore + BundleCache → manifest entry.
//   - Existing URL row → fetch → hash → store → flip entry's bundled flag.
//
// These are extracted from AssetManagerModal so they can be unit-tested
// without rendering React. The modal calls them directly and otherwise only
// owns the UI state machine (drag state, staging, error banner).

import { hashBlob } from './BundleHasher';
import type { BundleStore } from './BundleStore';
import type { BundleCache } from './BundleCache';
import {
  type AssetEntry,
  type AssetType,
  type Manifest,
  validateSlug,
} from './Manifest';

export interface BundledFileResult {
  hash: string;
  type: AssetType;
  slug: string;
  name: string;
}

// Inspect a File and decide which AssetType to default to in the manifest.
// MIME first, extension fallback. Unknown → null (caller surfaces an error
// and refuses to bundle — host can still add the asset via URL paste).
export function inferAssetTypeFromFile(file: File): AssetType | null {
  const mime = (file.type || '').toLowerCase();
  if (mime.startsWith('image/'))      return 'image';
  if (mime.startsWith('audio/'))      return 'sound';
  if (mime === 'model/gltf-binary' || mime === 'model/gltf+json') return 'model';
  if (mime === 'application/pdf')     return 'pdf';

  const lower = file.name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(lower))      return 'image';
  if (/\.(mp3|wav|ogg|m4a|aac|flac)$/.test(lower))        return 'sound';
  if (/\.(glb|gltf)$/.test(lower))                        return 'model';
  if (/\.pdf$/.test(lower))                                return 'pdf';
  return null;
}

// Hash a Blob, store it in BundleStore (idempotent — dedupes by hash), and
// pin it in BundleCache. The hash compute (crypto.subtle.digest) and IDB
// write are both off-thread, so the caller's UI stays responsive for large
// files. Cache write failures are swallowed inside BundleCache — the
// Promise resolves regardless.
export async function bundleBlob(
  blob:        Blob,
  bundleStore: BundleStore,
  bundleCache: BundleCache,
): Promise<string> {
  const hash = await hashBlob(blob);
  if (!bundleStore.has(hash)) {
    bundleStore.put(hash, blob);
    await bundleCache.put(hash, blob, { pinned: true });
  }
  return hash;
}

// Pick a `custom:<slug>` value not already used in the draft. Used when a
// host drops the same file twice and wants both manifest entries to coexist
// (issue acceptance: two manifest entries can reference the same hash).
export function uniqueCustomSlug(suggestion: string, draft: Manifest): string {
  const base = sanitiseSlug(suggestion) || 'asset';
  let slug = `custom:${base}`;
  if (validateSlug(slug, 'custom').ok && !draft.hasSlug(slug)) return slug;
  let i = 2;
  while (true) {
    slug = `custom:${base}-${i}`;
    if (validateSlug(slug, 'custom').ok && !draft.hasSlug(slug)) return slug;
    i++;
  }
}

function sanitiseSlug(input: string): string {
  // Lowercase, replace runs of non-[a-z0-9_-] with '-', strip leading
  // separators/digits so the slug body matches `[a-z][a-z0-9_/-]*`.
  let s = input.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  s = s.replace(/^[0-9-_]+/, '');
  return s;
}

// Strip extension + parent path off a filename to seed the slug.
export function fileStemForSlug(filename: string): string {
  const tail   = filename.substring(filename.lastIndexOf('/') + 1);
  const dotIdx = tail.lastIndexOf('.');
  return dotIdx > 0 ? tail.slice(0, dotIdx) : tail;
}

// Default `name` shown in the row label. Spaces look nicer than dashes here
// since name is for humans and slug is for code.
export function fileStemForName(filename: string): string {
  return fileStemForSlug(filename).replace(/[-_]+/g, ' ').trim();
}

// Build the AssetEntry shape for a freshly-uploaded file. Pure — caller is
// expected to insert it into the draft via `store.editDraft`.
export function entryFromUpload(args: {
  slug:    string;
  name:    string;
  type:    AssetType;
  hash:    string;
  size:    number;
  preload: boolean;
}): AssetEntry {
  return {
    slug:    args.slug,
    name:    args.name,
    type:    args.type,
    url:     '',
    preload: args.preload,
    bundled: true,
    hash:    args.hash,
    size:    args.size,
  };
}

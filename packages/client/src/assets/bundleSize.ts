// Bundled-asset size policy. Two thresholds, no hard caps:
//
//   - SINGLE_ASSET_WARN_BYTES — confirm-before-upload modal at 50MB.
//   - TOTAL_WARN_BYTES        — informational banner at 500MB total.
//
// The host can override both. Centralised here so tuning lives in one
// place and tests can import the numbers without hard-coding.

import { useSyncExternalStore } from 'react';
import { type Manifest } from './Manifest';
import { type ManifestStore } from './ManifestStore';

export const SINGLE_ASSET_WARN_BYTES = 50  * 1024 * 1024;   // 50 MB
export const TOTAL_WARN_BYTES        = 500 * 1024 * 1024;   // 500 MB

// Tally bundled entries across a manifest. `size` lives on the AssetEntry
// (set by the upload / Bundle-this flows; replicated through save and
// manifest-publish) so guests see the same totals as the host even before
// they've fetched any bytes.
export function bundleSizeOf(manifest: Manifest): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const e of manifest.toArray()) {
    if (e.bundled !== true) continue;
    count++;
    bytes += e.size ?? 0;
  }
  return { count, bytes };
}

// React hook for the AssetManagerModal footer + total-save banner.
// Subscribes to ManifestStore changes via useSyncExternalStore so the
// number updates without an explicit refresh.
export function useBundleSize(store: ManifestStore | null): { count: number; bytes: number } {
  return useSyncExternalStore(
    (cb) => store?.subscribe(cb) ?? (() => {}),
    () => store ? bundleSizeOf(store.getDraft()) : { count: 0, bytes: 0 },
  );
}

// Human-readable rendering — KB / MB / GB picked by magnitude. Plain
// 1024-based units for consistency with browser tools. One decimal at MB
// and above, no decimal at KB / B.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024)               return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024)                  return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024)                  return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

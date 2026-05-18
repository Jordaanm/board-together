// React hook for rendering a thumbnail / preview image for an AssetEntry.
//
//   - URL-backed entries → returns `entry.url` directly (or '' for synthetic
//     placeholder:// / primitive:// markers; callers gate display on the
//     return value).
//   - Bundled entries    → mints an Object URL from BundleStore.get(hash)
//     and revokes it on unmount / entry change.
//
// The same hook backs RowPreview in AssetManagerModal and the SheetGrid
// cells in GenerateDeckModal so bundled spritesheets render identically
// to URL-hosted ones.

import { useEffect, useState } from 'react';
import { type AssetEntry } from './Manifest';
import { type BundleStore } from './BundleStore';

export function useEntryImageSrc(
  entry:        AssetEntry,
  bundleStore?: BundleStore,
): string {
  const [src, setSrc] = useState<string>(entry.bundled === true ? '' : entry.url);
  useEffect(() => {
    if (entry.bundled !== true) {
      setSrc(entry.url);
      return;
    }
    const blob = bundleStore?.get(entry.hash ?? '');
    if (!blob) {
      setSrc('');
      return;
    }
    const url = URL.createObjectURL(blob);
    setSrc(url);
    return () => { URL.revokeObjectURL(url); };
  }, [entry.bundled, entry.hash, entry.url, bundleStore]);
  return src;
}

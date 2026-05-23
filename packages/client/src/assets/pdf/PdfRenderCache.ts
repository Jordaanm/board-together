// Per-slug LRU of rendered page textures, keyed by `(page, scale)`.
//
// Cap defaults to 3 textures per slug — enough to hold the current page
// plus the prev / next page that the navigation UI keeps warm. When the
// cap is exceeded the least-recently-used entry is dropped and its
// CanvasTexture is disposed so the GPU buffer is reclaimed.
//
// Slug isolation: a slug that fills its own LRU never evicts another
// slug's entries. Callers explicitly call `evict(slug)` to drop all
// entries for a slug (e.g. when the asset is deleted from the manifest).

import * as THREE from 'three';

const DEFAULT_CAPACITY_PER_SLUG = 3;

export interface PdfRenderCacheOptions {
  capacityPerSlug?: number;
}

function keyOf(page: number, scale: number): string {
  return `${page}|${scale}`;
}

export class PdfRenderCache {
  private readonly capacityPerSlug: number;
  // Map iteration order = insertion order, so the first key is the LRU
  // for that slug. `get` re-inserts to bump recency.
  private readonly slugs = new Map<string, Map<string, THREE.CanvasTexture>>();

  constructor(opts: PdfRenderCacheOptions = {}) {
    this.capacityPerSlug = opts.capacityPerSlug ?? DEFAULT_CAPACITY_PER_SLUG;
  }

  get(slug: string, page: number, scale: number): THREE.CanvasTexture | undefined {
    const slugMap = this.slugs.get(slug);
    if (!slugMap) return undefined;
    const k   = keyOf(page, scale);
    const tex = slugMap.get(k);
    if (!tex) return undefined;
    slugMap.delete(k);
    slugMap.set(k, tex);
    return tex;
  }

  put(slug: string, page: number, scale: number, texture: THREE.CanvasTexture): void {
    let slugMap = this.slugs.get(slug);
    if (!slugMap) {
      slugMap = new Map();
      this.slugs.set(slug, slugMap);
    }
    const k = keyOf(page, scale);
    slugMap.delete(k);
    slugMap.set(k, texture);
    while (slugMap.size > this.capacityPerSlug) {
      const oldestKey = slugMap.keys().next().value;
      if (oldestKey === undefined) break;
      const old = slugMap.get(oldestKey);
      slugMap.delete(oldestKey);
      old?.dispose();
    }
  }

  evict(slug: string): void {
    const slugMap = this.slugs.get(slug);
    if (!slugMap) return;
    for (const tex of slugMap.values()) tex.dispose();
    this.slugs.delete(slug);
  }

  size(slug: string): number {
    return this.slugs.get(slug)?.size ?? 0;
  }
}

// Per-asset hull cache. Keyed by the asset ref (slug or URL) supplied by
// the caller. First touch loads the model through AssetService, runs the
// GLB analyzer + hull builder, and stores the result. Subsequent touches
// for the same ref are served from cache.
//
// `getHullForAsset(ref)` is the public read API: synchronous, returns the
// cached HullData, `null` if a fallback is required (degenerate / failed),
// or `undefined` while the load is still in flight.
//
// `subscribeHull(ref, listener)` kicks off the load (if not already in
// flight) and fires `listener` once the cache entry settles to either
// `HullData` or `null`. PhysicsComponent uses this to rebuild its body
// shape from a temporary AABB once the real hull becomes available.

import * as THREE from 'three';
import { assetService } from '../assets/AssetService';
import { extractHullSource } from './glbAnalyzer';
import { buildHull, HULL_FALLBACK, type HullData } from './hullBuilder';

type CacheValue = HullData | null;
type CacheListener = (hull: CacheValue) => void;

interface Entry {
  status:    'pending' | 'ready';
  value:     CacheValue;
  listeners: Set<CacheListener>;
  unsubModel?: () => void;
}

const cache = new Map<string, Entry>();

export function getHullForAsset(ref: string): CacheValue | undefined {
  const entry = cache.get(ref);
  if (!entry) return undefined;
  return entry.status === 'ready' ? entry.value : undefined;
}

export function subscribeHull(ref: string, listener: CacheListener): () => void {
  let entry = cache.get(ref);
  if (!entry) {
    entry = { status: 'pending', value: null, listeners: new Set() };
    cache.set(ref, entry);
    startLoad(ref, entry);
  }
  entry.listeners.add(listener);
  if (entry.status === 'ready') listener(entry.value);
  return () => { entry!.listeners.delete(listener); };
}

// Internal: synchronously compute and cache a hull from an already-loaded
// model root. Used by the asset-subscription path; also exposed for tests
// that bypass AssetService.
export function computeAndStoreHull(ref: string, root: THREE.Object3D): CacheValue {
  let entry = cache.get(ref);
  if (entry && entry.status === 'ready') return entry.value;
  if (!entry) {
    entry = { status: 'pending', value: null, listeners: new Set() };
    cache.set(ref, entry);
  }
  const points = extractHullSource(root);
  const result = buildHull(points);
  const value: CacheValue = result === HULL_FALLBACK ? null : result;
  entry.value  = value;
  entry.status = 'ready';
  for (const l of entry.listeners) l(value);
  return value;
}

function startLoad(ref: string, entry: Entry): void {
  // Subscribe through AssetService so this code path works for slug refs,
  // URL refs, and bundled assets uniformly. Listener fires immediately
  // with a placeholder + 'pending'; we ignore that, then receive
  // 'loaded'/'broken' when the GLB resolves.
  entry.unsubModel = assetService.subscribe(ref, 'model', (obj, status) => {
    if (status === 'pending') return;
    if (status === 'broken') {
      entry.value  = null;
      entry.status = 'ready';
      for (const l of entry.listeners) l(null);
      entry.unsubModel?.(); entry.unsubModel = undefined;
      return;
    }
    // loaded
    try {
      computeAndStoreHull(ref, obj);
    } catch (err) {
      console.warn(`[hullCache] hull build failed for ${ref}:`, err);
      entry.value  = null;
      entry.status = 'ready';
      for (const l of entry.listeners) l(null);
    }
    entry.unsubModel?.(); entry.unsubModel = undefined;
  });
}

// Test-only: clear all cached entries. Should not be called from production
// code paths. Internal subscriptions are unhooked so leaked listeners don't
// race with the next test's setup.
export function _resetHullCacheForTests(): void {
  for (const entry of cache.values()) entry.unsubModel?.();
  cache.clear();
}

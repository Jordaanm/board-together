import { describe, test, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { computeAndStoreHull, getHullForAsset, _resetHullCacheForTests } from './hullCache';

function makeCube(): THREE.Object3D {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
  return root;
}

beforeEach(() => { _resetHullCacheForTests(); });

describe('hullCache — dedup per asset URL', () => {
  test('first call populates cache; second call returns same HullData by reference', () => {
    const root = makeCube();
    const a = computeAndStoreHull('asset://cube', root);
    const b = computeAndStoreHull('asset://cube', root);
    expect(a).not.toBeNull();
    expect(b).toBe(a); // exact object identity → builder did not rerun
  });

  test('different URLs produce independent cache entries', () => {
    const a = computeAndStoreHull('asset://A', makeCube());
    const b = computeAndStoreHull('asset://B', makeCube());
    expect(a).not.toBe(b); // different builds, different result objects
    expect(getHullForAsset('asset://A')).toBe(a);
    expect(getHullForAsset('asset://B')).toBe(b);
  });

  test('getHullForAsset before any compute returns undefined', () => {
    expect(getHullForAsset('asset://nothing')).toBeUndefined();
  });

  test('degenerate input caches null and reports it on subsequent reads', () => {
    const empty = new THREE.Group(); // no meshes → 0 points → fallback
    const result = computeAndStoreHull('asset://empty', empty);
    expect(result).toBeNull();
    expect(getHullForAsset('asset://empty')).toBeNull();
  });

  test('cache key is the asset URL — _collision-driven vs merged source is opaque', () => {
    // Two distinct roots: one uses a `_collision` child; the other merges
    // its visual mesh. Both register under the same ref, but only the
    // first computation actually populates the cache — the second is a
    // no-op that returns the cached value by reference.
    const withCollision = new THREE.Group();
    withCollision.add(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10)));
    const coll = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    coll.name = '_collision';
    withCollision.add(coll);

    const visualOnly = new THREE.Group();
    visualOnly.add(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10)));

    const first  = computeAndStoreHull('asset://chest', withCollision);
    const second = computeAndStoreHull('asset://chest', visualOnly);
    expect(second).toBe(first); // same key → cached entry returned, source irrelevant
  });
});

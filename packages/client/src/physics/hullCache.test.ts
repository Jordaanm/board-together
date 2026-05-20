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
});

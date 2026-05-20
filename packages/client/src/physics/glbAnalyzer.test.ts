import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import { extractHullSource } from './glbAnalyzer';

describe('glbAnalyzer — extractHullSource (slice #1: merge all meshes)', () => {
  test('returns vertices from every mesh in the scene', () => {
    const root = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    b.position.set(5, 0, 0);
    root.add(a, b);
    const points = extractHullSource(root);
    // BoxGeometry has 24 position entries (6 faces × 4 vertices). Two boxes
    // → 48 entries.
    expect(points).toHaveLength(48);
  });

  test('vertex coordinates are baked through each node world transform', () => {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(10, 20, 30);
    root.add(mesh);
    const points = extractHullSource(root);
    // Every vertex of the cube should be offset by (10, 20, 30) ± 0.5.
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(9.5 - 1e-6);
      expect(p.x).toBeLessThanOrEqual(10.5 + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(19.5 - 1e-6);
      expect(p.z).toBeGreaterThanOrEqual(29.5 - 1e-6);
    }
  });

  test('ignores nodes without geometry', () => {
    const root = new THREE.Group();
    root.add(new THREE.Object3D());                                  // empty
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));        // mesh
    const points = extractHullSource(root);
    expect(points).toHaveLength(24);
  });

  test('returns empty list when scene has no meshes', () => {
    const root = new THREE.Group();
    root.add(new THREE.Object3D());
    expect(extractHullSource(root)).toHaveLength(0);
  });
});

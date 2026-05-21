import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import { extractAuthoredHull, extractHullSource, findCollisionNode } from './glbAnalyzer';
import { buildHull, HULL_FALLBACK } from './hullBuilder';

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

describe('glbAnalyzer — _collision child overrides merge-all', () => {
  test('with a _collision child, returns only that node\'s geometry', () => {
    const root = new THREE.Group();
    // Visual mesh: a tall box.
    root.add(new THREE.Mesh(new THREE.BoxGeometry(2, 5, 2)));
    // Collider: a much smaller box, named exactly `_collision`.
    const collider = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    collider.name = '_collision';
    root.add(collider);

    const points = extractHullSource(root);
    // 1×1×1 box has 24 vertex entries (6 faces × 4 vertices).
    expect(points).toHaveLength(24);
    // All points should be within ±0.5 on every axis — i.e. the small
    // box's bounds, not the tall one's.
    for (const p of points) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(0.5 + 1e-6);
    }
  });

  test('the _collision node\'s world transform bakes into the extracted points', () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10))); // ignored

    const intermediate = new THREE.Group();
    intermediate.position.set(5, 0, 0);
    root.add(intermediate);

    const collider = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    collider.name = '_collision';
    collider.position.set(0, 7, 0);
    intermediate.add(collider);

    const points = extractHullSource(root);
    // Expected world centre: (5, 7, 0) ± 0.5 on each axis.
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(4.5 - 1e-6);
      expect(p.x).toBeLessThanOrEqual(5.5 + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(6.5 - 1e-6);
      expect(p.y).toBeLessThanOrEqual(7.5 + 1e-6);
    }
  });

  test('similarly named nodes are NOT treated as collision (case-sensitive literal match)', () => {
    for (const name of ['_collision_temp', '_Collision', 'collision', '_collisionA']) {
      const root = new THREE.Group();
      root.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2)));
      const decoy = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
      decoy.name = name;
      root.add(decoy);

      // Two boxes → 48 vertex entries (merge-all path).
      expect(extractHullSource(root)).toHaveLength(48);
      expect(findCollisionNode(root)).toBeNull();
    }
  });

  test('low-poly _collision child produces a strictly tighter hull than the visual mesh', () => {
    // Visual: a fat tall cube. Collider: a slim variant.
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4)));

    const collider = new THREE.Mesh(new THREE.BoxGeometry(1, 4, 1));
    collider.name = '_collision';
    root.add(collider);

    const hull = buildHull(extractHullSource(root));
    if (hull === HULL_FALLBACK) throw new Error('expected hull');

    // Every hull vertex's X and Z magnitude should stay within the
    // collider's ±0.5 bound, never reaching the visual ±2.
    for (const [x, _y, z] of hull.vertices) {
      expect(Math.abs(x)).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(Math.abs(z)).toBeLessThanOrEqual(0.5 + 1e-6);
    }
  });
});

describe('glbAnalyzer — extractAuthoredHull (direct triangle use)', () => {
  test('returns null when no _collision node exists', () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    expect(extractAuthoredHull(root)).toBeNull();
  });

  test('returns vertices + triangle faces from the _collision mesh', () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4)));   // ignored
    const collider = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    collider.name = '_collision';
    root.add(collider);

    const authored = extractAuthoredHull(root);
    if (authored === null) throw new Error('expected authored hull');
    // Indexed BoxGeometry has 8 unique corners and 12 triangles. The
    // analyzer dedupes by coordinate so the vertex table stays minimal.
    expect(authored.vertices).toHaveLength(8);
    expect(authored.faces).toHaveLength(12);
    for (const tri of authored.faces) expect(tri).toHaveLength(3);
  });

  test('bakes the _collision node\'s world transform into the vertices', () => {
    const root = new THREE.Group();
    const collider = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    collider.name = '_collision';
    collider.position.set(10, 0, 0);
    root.add(collider);

    const authored = extractAuthoredHull(root);
    if (authored === null) throw new Error('expected authored hull');
    for (const [x] of authored.vertices) {
      expect(x).toBeGreaterThanOrEqual(9.5 - 1e-6);
      expect(x).toBeLessThanOrEqual(10.5 + 1e-6);
    }
  });

  test('returns null when _collision exists but has no triangles', () => {
    const root = new THREE.Group();
    const empty = new THREE.Group();
    empty.name = '_collision';
    root.add(empty);
    expect(extractAuthoredHull(root)).toBeNull();
  });
});

describe('glbAnalyzer — findCollisionNode', () => {
  test('returns the node when name matches exactly', () => {
    const root = new THREE.Group();
    const target = new THREE.Object3D();
    target.name = '_collision';
    root.add(target);
    expect(findCollisionNode(root)).toBe(target);
  });

  test('returns null when no node matches', () => {
    const root = new THREE.Group();
    root.add(new THREE.Object3D());
    expect(findCollisionNode(root)).toBeNull();
  });
});

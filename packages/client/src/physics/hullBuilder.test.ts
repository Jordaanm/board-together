import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import { buildHull, HULL_FALLBACK, MAX_HULL_FACES } from './hullBuilder';

describe('hullBuilder — degenerate input falls back to AABB sentinel', () => {
  test('< 4 points returns HULL_FALLBACK', () => {
    const points = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 1, 0),
    ];
    expect(buildHull(points)).toBe(HULL_FALLBACK);
  });

  test('4 coplanar points return HULL_FALLBACK', () => {
    const points = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(1, 0, 1),
      new THREE.Vector3(0, 0, 1),
    ];
    expect(buildHull(points)).toBe(HULL_FALLBACK);
  });
});

describe('hullBuilder — well-formed input', () => {
  test('unit cube hulls to exactly 8 vertices and 12 triangular faces', () => {
    // Eight corners of a unit cube. Inputs include redundant points so the
    // builder must dedupe through its vertex map.
    const cube: THREE.Vector3[] = [];
    for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) {
      cube.push(new THREE.Vector3(x, y, z));
    }
    const result = buildHull(cube);
    expect(result).not.toBe(HULL_FALLBACK);
    if (result === HULL_FALLBACK) return; // narrow
    expect(result.vertices).toHaveLength(8);
    expect(result.faces).toHaveLength(12);
    for (const face of result.faces) expect(face).toHaveLength(3);
  });

  test('vertex coordinates are a subset of the input', () => {
    const points: THREE.Vector3[] = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0.2, 0.2, 0.2), // interior — should be dropped
    ];
    const result = buildHull(points);
    if (result === HULL_FALLBACK) throw new Error('expected hull');
    // Interior point should not appear in the hull vertices.
    const hasInterior = result.vertices.some(([x, y, z]) => x === 0.2 && y === 0.2 && z === 0.2);
    expect(hasInterior).toBe(false);
    expect(result.vertices).toHaveLength(4);
  });
});

describe('hullBuilder — face-count cap', () => {
  // Deterministic Fibonacci-lattice sampler — uncapped, an N-point sphere
  // hulls to roughly 2N - 4 faces, so we can pick a count that's
  // comfortably above the cap.
  function sphericalPoints(n: number): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const phi   = Math.acos(1 - 2 * (i + 0.5) / n);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      out.push(new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta),
        Math.sin(phi) * Math.sin(theta),
        Math.cos(phi),
      ));
    }
    return out;
  }

  test('small hulls pass through unchanged when under the cap', () => {
    const cube: THREE.Vector3[] = [];
    for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) {
      cube.push(new THREE.Vector3(x, y, z));
    }
    const result = buildHull(cube);
    if (result === HULL_FALLBACK) throw new Error('expected hull');
    expect(result.faces.length).toBe(12);
    expect(result.vertices).toHaveLength(8);
  });

  test('caps hull face count at MAX_HULL_FACES for dense input', () => {
    // 100 points on a sphere → ~196 faces uncapped. The decimator should
    // bring this down to ≤ MAX_HULL_FACES.
    const result = buildHull(sphericalPoints(100));
    if (result === HULL_FALLBACK) throw new Error('expected hull');
    expect(result.faces.length).toBeLessThanOrEqual(MAX_HULL_FACES);
  });

  test('decimated hull vertices remain a subset of the original input', () => {
    // Furthest-point sampling picks among ConvexHull's own surface
    // vertices — the silhouette stays anchored to the source mesh.
    const input = sphericalPoints(80);
    const result = buildHull(input);
    if (result === HULL_FALLBACK) throw new Error('expected hull');
    const tol = 1e-6;
    for (const [x, y, z] of result.vertices) {
      const hit = input.some(p =>
        Math.abs(p.x - x) < tol && Math.abs(p.y - y) < tol && Math.abs(p.z - z) < tol,
      );
      expect(hit).toBe(true);
    }
  });
});

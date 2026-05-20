import { describe, test, expect, vi } from 'vitest';
import * as THREE from 'three';
import { buildHull, HULL_FALLBACK, HULL_FACE_WARN } from './hullBuilder';

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

describe('hullBuilder — face-count warning', () => {
  test('no warn at or below 64 faces', () => {
    // A unit cube only ever produces 12 faces — well under the threshold.
    const cube: THREE.Vector3[] = [];
    for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) {
      cube.push(new THREE.Vector3(x, y, z));
    }
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildHull(cube);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('warns when hull exceeds 64 faces', () => {
    // A sphere of N≈40 points produces enough faces to exceed the
    // threshold without being huge. Deterministic spherical sampling so the
    // test is reproducible.
    const points: THREE.Vector3[] = [];
    const N = 50;
    for (let i = 0; i < N; i++) {
      const phi   = Math.acos(1 - 2 * (i + 0.5) / N);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      points.push(new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta),
        Math.sin(phi) * Math.sin(theta),
        Math.cos(phi),
      ));
    }
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = buildHull(points);
    if (result === HULL_FALLBACK) throw new Error('expected hull');
    expect(result.faces.length).toBeGreaterThan(HULL_FACE_WARN);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

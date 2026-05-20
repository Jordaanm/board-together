import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import {
  buildHitboxWireframe,
  HITBOX_MATERIAL,
  HITBOX_RENDER_ORDER,
} from './hitboxWireframe';

describe('buildHitboxWireframe — material + render-order are shared', () => {
  test('every shape reuses the same LineBasicMaterial instance', () => {
    const box   = buildHitboxWireframe(new CANNON.Box(new CANNON.Vec3(1, 1, 1)));
    const sphere = buildHitboxWireframe(new CANNON.Sphere(1));
    expect(box.material).toBe(HITBOX_MATERIAL);
    expect(sphere.material).toBe(HITBOX_MATERIAL);
  });

  test('material has depthTest off so wireframe renders through occluders', () => {
    expect(HITBOX_MATERIAL.depthTest).toBe(false);
  });

  test('renderOrder is set high so the overlay paints last', () => {
    const lines = buildHitboxWireframe(new CANNON.Box(new CANNON.Vec3(1, 1, 1)));
    expect(lines.renderOrder).toBe(HITBOX_RENDER_ORDER);
  });
});

describe('buildHitboxWireframe — per-shape geometry', () => {
  test('Box produces 12 edges = 24 position entries', () => {
    const lines = buildHitboxWireframe(new CANNON.Box(new CANNON.Vec3(1, 2, 3)));
    const pos = lines.geometry.attributes.position;
    expect(pos.count).toBe(24);
    // Verify the wireframe spans the box's full extents (±halfExtents).
    lines.geometry.computeBoundingBox();
    const bb = lines.geometry.boundingBox!;
    expect(bb.min.x).toBeCloseTo(-1, 6);
    expect(bb.max.x).toBeCloseTo(1, 6);
    expect(bb.min.y).toBeCloseTo(-2, 6);
    expect(bb.max.y).toBeCloseTo(2, 6);
    expect(bb.min.z).toBeCloseTo(-3, 6);
    expect(bb.max.z).toBeCloseTo(3, 6);
  });

  test('Sphere produces a non-empty wireframe within its radius', () => {
    const lines = buildHitboxWireframe(new CANNON.Sphere(2));
    expect(lines.geometry.attributes.position.count).toBeGreaterThan(0);
    lines.geometry.computeBoundingSphere();
    expect(lines.geometry.boundingSphere!.radius).toBeCloseTo(2, 1);
  });

  test('Cylinder produces a wireframe bounding the requested radius + height', () => {
    const lines = buildHitboxWireframe(new CANNON.Cylinder(1, 1, 4, 16));
    expect(lines.geometry.attributes.position.count).toBeGreaterThan(0);
    lines.geometry.computeBoundingBox();
    const bb = lines.geometry.boundingBox!;
    // Three's CylinderGeometry default is along +Y, height = full Y extent.
    expect(bb.max.y - bb.min.y).toBeCloseTo(4, 1);
    expect(bb.max.x).toBeLessThanOrEqual(1 + 1e-3);
    expect(bb.min.x).toBeGreaterThanOrEqual(-1 - 1e-3);
  });

  test('ConvexPolyhedron (tetrahedron) produces 6 unique edges = 12 position entries', () => {
    // Regular tetrahedron with 4 triangular faces. Euler: V−E+F = 2 →
    // 4 − E + 4 = 2 → 6 edges → 12 endpoint entries.
    const vertices = [
      new CANNON.Vec3( 1,  1,  1),
      new CANNON.Vec3(-1, -1,  1),
      new CANNON.Vec3(-1,  1, -1),
      new CANNON.Vec3( 1, -1, -1),
    ];
    const faces = [
      [0, 1, 2],
      [0, 3, 1],
      [0, 2, 3],
      [1, 3, 2],
    ];
    const lines = buildHitboxWireframe(new CANNON.ConvexPolyhedron({ vertices, faces }));
    expect(lines.geometry.attributes.position.count).toBe(12);
  });
});

describe('buildHitboxWireframe — unknown shape falls back to empty geometry', () => {
  test('returns LineSegments with zero positions for an unsupported shape', () => {
    const fake = { type: 999 } as unknown as CANNON.Shape;
    const lines = buildHitboxWireframe(fake);
    expect(lines).toBeInstanceOf(THREE.LineSegments);
    const pos = lines.geometry.attributes.position;
    expect(pos === undefined || pos.count === 0).toBe(true);
  });
});

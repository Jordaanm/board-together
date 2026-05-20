// Auto-hull branch of PhysicsComponent.buildShape — issue #1 of
// planning/issues--hull.md.

import { describe, test, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { SceneImpl } from '../Scene';
import { type SpawnContext } from '../EntityComponent';
import { PhysicsComponent } from './PhysicsComponent';
import { TransformComponent } from './TransformComponent';
import { registerCorePrimitives } from '../spawnables';
import { PhysicsWorld } from '../../physics/PhysicsWorld';
import { computeAndStoreHull, _resetHullCacheForTests } from '../../physics/hullCache';
import { DEFAULT_BAG_SLUG } from '../../assets/baseManifest';

let scene: SceneImpl;
let ctx: SpawnContext;

// A small distinctive geometry so the resulting hull vertices are easy to
// assert against. Eight cube corners → hull = exactly that cube.
function seedBagHullCache(): void {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  root.add(mesh);
  computeAndStoreHull(DEFAULT_BAG_SLUG, root);
}

beforeEach(() => {
  registerCorePrimitives();
  scene = new SceneImpl();
  ctx = { scene: new THREE.Scene(), physics: new PhysicsWorld(), entityScene: scene };
  _resetHullCacheForTests();
});

describe('PhysicsComponent — no-regression for spawnables without physics.shape', () => {
  test('die continues to use a CANNON.Box', () => {
    const e = scene.spawn('die', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    expect(phys.body.shapes[0]).toBeInstanceOf(CANNON.Box);
  });

  test('d20 continues to use a hand-coded CANNON.ConvexPolyhedron (icosahedron path)', () => {
    const e = scene.spawn('d20', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    expect(phys.body.shapes[0]).toBeInstanceOf(CANNON.ConvexPolyhedron);
    const poly = phys.body.shapes[0] as CANNON.ConvexPolyhedron;
    // Regular icosahedron: 12 vertices, 20 faces. Sanity-check that the
    // existing hand-coded path is intact.
    expect(poly.vertices).toHaveLength(12);
    expect(poly.faces).toHaveLength(20);
  });

  test('meeple token continues to use a CANNON.Cylinder', () => {
    const e = scene.spawn('token', ctx);
    expect(e.getComponent(PhysicsComponent)!.body.shapes[0]).toBeInstanceOf(CANNON.Cylinder);
  });
});

describe("PhysicsComponent — 'auto-hull' branch", () => {
  test('builds a ConvexPolyhedron when the hull is cached', () => {
    seedBagHullCache();
    const e = scene.spawn('bag', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    expect(phys.body.shapes[0]).toBeInstanceOf(CANNON.ConvexPolyhedron);
    const poly = phys.body.shapes[0] as CANNON.ConvexPolyhedron;
    expect(poly.vertices).toHaveLength(8);
    expect(poly.faces).toHaveLength(12);
  });

  test('vertex coordinates scale by transform.state.scale', () => {
    seedBagHullCache();
    const e = scene.spawn('bag', ctx);
    e.getComponent(TransformComponent)!.setState({
      position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [2, 2, 2],
    });
    e.getComponent(PhysicsComponent)!.rebuildShape();
    const poly = e.getComponent(PhysicsComponent)!.body.shapes[0] as CANNON.ConvexPolyhedron;
    // Cached cube vertices are ±0.5. Scaled by 2 → ±1.
    for (const v of poly.vertices) {
      expect(Math.abs(v.x)).toBeCloseTo(1, 6);
      expect(Math.abs(v.y)).toBeCloseTo(1, 6);
      expect(Math.abs(v.z)).toBeCloseTo(1, 6);
    }
  });

  test('asset failure (cache settles to null) → CANNON.Box fallback + console.warn', () => {
    // Seed the cache with a deliberately-empty source (no meshes). The
    // hull builder returns its degenerate sentinel and the cache stores
    // null, so the next spawn experiences the failure path end-to-end
    // without depending on async AssetService behaviour.
    computeAndStoreHull(DEFAULT_BAG_SLUG, new THREE.Group());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const e = scene.spawn('bag', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    expect(phys.body.shapes[0]).toBeInstanceOf(CANNON.Box);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

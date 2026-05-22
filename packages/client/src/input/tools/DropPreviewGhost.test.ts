// DropPreviewGhost lifecycle — issue #3 of planning/issues--drag-refactor.md.

import { describe, test, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { SceneImpl } from '../../entity/Scene';
import { type SpawnContext } from '../../entity/EntityComponent';
import { TransformComponent } from '../../entity/components/TransformComponent';
import { registerCorePrimitives } from '../../entity/spawnables';
import { PhysicsWorld } from '../../physics/PhysicsWorld';
import { type EntityHandle } from '../../entity/world';
import { DropPreviewGhost } from './DropPreviewGhost';

let scene:      SceneImpl;
let threeScene: THREE.Scene;
let ctx:        SpawnContext;

function handleFor(entity: ReturnType<SceneImpl['spawn']>): EntityHandle {
  return {
    id:     entity.id,
    entity,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get:    (cls: any) => entity.getComponent(cls),
  } as unknown as EntityHandle;
}

function findGhost(s: THREE.Scene): THREE.Object3D | undefined {
  let hit: THREE.Object3D | undefined;
  s.traverse((node) => {
    if (!hit && node.name === 'DropPreviewGhost') hit = node;
  });
  return hit;
}

beforeEach(() => {
  registerCorePrimitives();
  scene      = new SceneImpl();
  threeScene = new THREE.Scene();
  ctx        = { scene: threeScene, physics: new PhysicsWorld(), entityScene: scene };
});

describe('DropPreviewGhost — lifecycle', () => {
  test('attach adds a clone to the scene; isAttached flips true', () => {
    const ghost = new DropPreviewGhost(threeScene);
    const e     = scene.spawn('die', ctx);
    ghost.attach(handleFor(e));
    expect(ghost.isAttached()).toBe(true);
    expect(findGhost(threeScene)).toBeDefined();
  });

  test('detach removes the clone from the scene and isAttached returns false', () => {
    const ghost = new DropPreviewGhost(threeScene);
    const e     = scene.spawn('die', ctx);
    ghost.attach(handleFor(e));
    ghost.detach();
    expect(ghost.isAttached()).toBe(false);
    expect(findGhost(threeScene)).toBeUndefined();
  });

  test('re-attach drops the prior clone before building a new one', () => {
    const ghost = new DropPreviewGhost(threeScene);
    const a     = scene.spawn('die', ctx);
    const b     = scene.spawn('token', ctx);
    ghost.attach(handleFor(a));
    const first = findGhost(threeScene);
    ghost.attach(handleFor(b));
    expect(first?.parent).toBeNull();        // detached from scene
    const next = findGhost(threeScene);
    expect(next).toBeDefined();
    expect(next).not.toBe(first);
  });

  test('attach on an entity without TransformComponent is a silent no-op', () => {
    const ghost = new DropPreviewGhost(threeScene);
    const fake = {
      id: 'no-transform',
      entity: {} as never,
      get: () => undefined,
    } as unknown as EntityHandle;
    const before = threeScene.children.length;
    ghost.attach(fake);
    expect(ghost.isAttached()).toBe(false);
    expect(threeScene.children.length).toBe(before);
  });
});

describe('DropPreviewGhost — per-frame update', () => {
  test('update with a surfaceY positions ghost at (draggedX, surfaceY, draggedZ) and shows it', () => {
    const ghost = new DropPreviewGhost(threeScene);
    const e     = scene.spawn('die', ctx);
    const t     = e.getComponent(TransformComponent)!;
    t.setState({ position: [2, 1.5, -3], rotation: t.state.rotation, scale: t.state.scale });
    ghost.attach(handleFor(e));

    ghost.update(0.1);

    const g = findGhost(threeScene)!;
    expect(g.visible).toBe(true);
    expect(g.position.x).toBeCloseTo(2);
    expect(g.position.y).toBeCloseTo(0.1);
    expect(g.position.z).toBeCloseTo(-3);
  });

  test('rotation matches the dragged entity', () => {
    const ghost = new DropPreviewGhost(threeScene);
    const e     = scene.spawn('die', ctx);
    const t     = e.getComponent(TransformComponent)!;
    // 90° yaw rotation.
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    t.setState({
      position: t.state.position,
      rotation: [q.x, q.y, q.z, q.w],
      scale:    t.state.scale,
    });
    ghost.attach(handleFor(e));
    ghost.update(0);

    const g = findGhost(threeScene)!;
    expect(g.quaternion.y).toBeCloseTo(Math.sin(Math.PI / 4), 6);
    expect(g.quaternion.w).toBeCloseTo(Math.cos(Math.PI / 4), 6);
  });

  test('update with null surfaceY hides the ghost (off-table fallback case)', () => {
    const ghost = new DropPreviewGhost(threeScene);
    const e     = scene.spawn('die', ctx);
    ghost.attach(handleFor(e));
    ghost.update(0.1);
    const g = findGhost(threeScene)!;
    expect(g.visible).toBe(true);
    ghost.update(null);
    expect(g.visible).toBe(false);
  });

  test('ghost tracks the dragged entity as it moves between frames', () => {
    const ghost = new DropPreviewGhost(threeScene);
    const e     = scene.spawn('die', ctx);
    const t     = e.getComponent(TransformComponent)!;
    ghost.attach(handleFor(e));

    t.setState({ position: [1, 5, 1], rotation: t.state.rotation, scale: t.state.scale });
    ghost.update(0);
    const g = findGhost(threeScene)!;
    expect(g.position.x).toBeCloseTo(1);
    expect(g.position.z).toBeCloseTo(1);

    t.setState({ position: [-2, 5, 4], rotation: t.state.rotation, scale: t.state.scale });
    ghost.update(0.5);
    expect(g.position.x).toBeCloseTo(-2);
    expect(g.position.y).toBeCloseTo(0.5);
    expect(g.position.z).toBeCloseTo(4);
  });

  test('update() before attach() is a silent no-op', () => {
    const ghost = new DropPreviewGhost(threeScene);
    expect(() => ghost.update(0.1)).not.toThrow();
    expect(() => ghost.update(null)).not.toThrow();
  });
});

describe('DropPreviewGhost — material isolation', () => {
  test('ghost uses translucent override materials, not the entity originals', () => {
    const ghost = new DropPreviewGhost(threeScene);
    const e     = scene.spawn('die', ctx);
    ghost.attach(handleFor(e));
    const g = findGhost(threeScene)!;
    let sawTranslucent = false;
    g.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        const mat = node.material as THREE.Material;
        if (mat.transparent && mat.opacity < 1) sawTranslucent = true;
      }
    });
    expect(sawTranslucent).toBe(true);
  });
});

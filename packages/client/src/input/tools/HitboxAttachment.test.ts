// HitboxAttachment lifecycle — issue #3 of planning/issues--hull.md.

import { describe, test, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { SceneImpl } from '../../entity/Scene';
import { type SpawnContext } from '../../entity/EntityComponent';
import { PhysicsComponent } from '../../entity/components/PhysicsComponent';
import { registerCorePrimitives } from '../../entity/spawnables';
import { PhysicsWorld } from '../../physics/PhysicsWorld';
import { type EntityHandle } from '../../entity/world';
import { type ToolContext } from './types';
import { HitboxAttachment } from './HitboxAttachment';

let scene:    SceneImpl;
let threeScene: THREE.Scene;
let ctx:      SpawnContext;
let toolCtx:  ToolContext;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleFor(entity: ReturnType<SceneImpl['spawn']>): EntityHandle {
  return {
    id:     entity.id,
    entity,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get:    (cls: any) => entity.getComponent(cls),
  } as unknown as EntityHandle;
}

function findHitboxGroup(s: THREE.Scene): THREE.Group | undefined {
  // Spawn adds the entity's MeshComponent group(s) to the scene too — filter
  // by the name HitboxAttachment sets on its overlay root.
  let hit: THREE.Group | undefined;
  s.traverse((node) => {
    if (!hit && node instanceof THREE.Group && node.name === 'HitboxAttachment') {
      hit = node;
    }
  });
  return hit;
}

beforeEach(() => {
  registerCorePrimitives();
  scene      = new SceneImpl();
  threeScene = new THREE.Scene();
  ctx        = { scene: threeScene, physics: new PhysicsWorld(), entityScene: scene };
  toolCtx    = {} as ToolContext;
});

describe('HitboxAttachment — gating + lifecycle', () => {
  test('disabled by default — attach() is a no-op', () => {
    const att = new HitboxAttachment(threeScene);
    const e   = scene.spawn('die', ctx);
    att.attach(handleFor(e), toolCtx);
    expect(att.isAttached()).toBe(false);
    expect(findHitboxGroup(threeScene)).toBeUndefined();
  });

  test('enabled + entity with PhysicsComponent → group added with one child per shape', () => {
    const att = new HitboxAttachment(threeScene);
    att.enabled = true;
    const e = scene.spawn('die', ctx);
    att.attach(handleFor(e), toolCtx);
    expect(att.isAttached()).toBe(true);
    const group = findHitboxGroup(threeScene) as THREE.Group;
    expect(group).toBeDefined();
    expect(group.children).toHaveLength(1); // die body has one Box shape
  });

  test('enabled + entity without PhysicsComponent → silent no-op (no scene additions)', () => {
    const att = new HitboxAttachment(threeScene);
    att.enabled = true;
    const before = threeScene.children.length;
    const fakeHandle = {
      id: 'no-phys',
      entity: {} as never,
      get: () => undefined,
    } as unknown as EntityHandle;
    att.attach(fakeHandle, toolCtx);
    expect(att.isAttached()).toBe(false);
    expect(threeScene.children.length).toBe(before);
  });

  test('detach removes the group and isAttached returns false', () => {
    const att = new HitboxAttachment(threeScene);
    att.enabled = true;
    const e = scene.spawn('die', ctx);
    att.attach(handleFor(e), toolCtx);
    att.detach();
    expect(att.isAttached()).toBe(false);
    expect(findHitboxGroup(threeScene)).toBeUndefined();
  });

  test('re-attach on a new handle disposes the previous group', () => {
    const att = new HitboxAttachment(threeScene);
    att.enabled = true;
    const e1 = scene.spawn('die', ctx);
    const e2 = scene.spawn('token', ctx);
    att.attach(handleFor(e1), toolCtx);
    const first = findHitboxGroup(threeScene);
    att.attach(handleFor(e2), toolCtx);
    expect(first?.parent).toBeNull();        // detached from the scene
    const next = findHitboxGroup(threeScene);
    expect(next).toBeDefined();
    expect(next).not.toBe(first);            // a fresh group for the new selection
  });
});

describe('HitboxAttachment — setEnabled toggles mid-inspection', () => {
  test('flipping on with a current selection materialises the wireframe', () => {
    const att = new HitboxAttachment(threeScene);
    const e   = scene.spawn('die', ctx);
    att.setEnabled(true, handleFor(e), toolCtx);
    expect(att.isAttached()).toBe(true);
  });

  test('flipping off immediately disposes the wireframe', () => {
    const att = new HitboxAttachment(threeScene);
    att.enabled = true;
    const e = scene.spawn('die', ctx);
    att.attach(handleFor(e), toolCtx);
    att.setEnabled(false, null, null);
    expect(att.isAttached()).toBe(false);
    expect(findHitboxGroup(threeScene)).toBeUndefined();
  });
});

describe('HitboxAttachment — per-frame transform sync', () => {
  test('update() copies the body world pose into the group', () => {
    const att = new HitboxAttachment(threeScene);
    att.enabled = true;
    const e    = scene.spawn('die', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    att.attach(handleFor(e), toolCtx);

    phys.body.position.set(5, 7, 9);
    phys.body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.PI / 2);
    att.update(0);

    const group = findHitboxGroup(threeScene) as THREE.Group;
    expect(group.position.x).toBeCloseTo(5, 6);
    expect(group.position.y).toBeCloseTo(7, 6);
    expect(group.position.z).toBeCloseTo(9, 6);
    expect(group.quaternion.y).toBeCloseTo(Math.sin(Math.PI / 4), 6);
    expect(group.quaternion.w).toBeCloseTo(Math.cos(Math.PI / 4), 6);
  });
});

describe('HitboxAttachment — compound bodies', () => {
  test('a body with two shapes at different offsets renders two correctly-placed children', () => {
    const att = new HitboxAttachment(threeScene);
    att.enabled = true;
    const e = scene.spawn('die', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    // Attach a second box at a non-zero offset on the same body. Exercises
    // body.shapes[]/shapeOffsets[]/shapeOrientations[] iteration.
    phys.body.addShape(
      new CANNON.Box(new CANNON.Vec3(0.1, 0.1, 0.1)),
      new CANNON.Vec3(3, 0, 0),
    );
    att.attach(handleFor(e), toolCtx);
    const group = findHitboxGroup(threeScene) as THREE.Group;
    expect(group.children).toHaveLength(2);
    expect(group.children[1].position.x).toBeCloseTo(3, 6);
  });
});

describe('HitboxAttachment — Table is NOT excluded (unlike AxisGizmoAttachment)', () => {
  test('selecting the Table while enabled renders its collider wireframe', () => {
    const att = new HitboxAttachment(threeScene);
    att.enabled = true;
    const table = scene.spawn('table', ctx);
    att.attach(handleFor(table), toolCtx);
    expect(att.isAttached()).toBe(true);
    const group = findHitboxGroup(threeScene);
    expect(group).toBeDefined();
  });
});

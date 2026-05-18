import { describe, test, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { SceneImpl, entityToSerialized, type EntitySerialized } from './Scene';
import { type SpawnContext } from './EntityComponent';
import { TransformComponent } from './components/TransformComponent';
import { MeshComponent } from './components/MeshComponent';
import { PhysicsComponent } from './components/PhysicsComponent';
import { ValueComponent } from './components/ValueComponent';
import { DiceComponent } from './components/DiceComponent';
import { registerCorePrimitives } from './spawnables';
import { D6_FACE_MAP } from '../dice/d6';
import { D20_FACE_MAP } from '../dice/d20';
import * as CANNON from 'cannon-es';
import { PhysicsWorld } from '../physics/PhysicsWorld';

let scene: SceneImpl;
let ctx: SpawnContext;

beforeEach(() => {
  registerCorePrimitives();
  scene = new SceneImpl();
  ctx = { scene: new THREE.Scene(), physics: new PhysicsWorld(), entityScene: scene };
});

describe('spawnables — board / die / token spawn', () => {
  test('die spawns with transform/mesh/physics/value/dice components', () => {
    const e = scene.spawn('die', ctx);
    expect(e.type).toBe('die');
    expect(e.tags).toEqual(['die']);
    expect(e.getComponent(TransformComponent)).toBeDefined();
    expect(e.getComponent(MeshComponent)).toBeDefined();
    expect(e.getComponent(PhysicsComponent)).toBeDefined();
    expect(e.getComponent(ValueComponent)).toBeDefined();
    const dice = e.getComponent(DiceComponent);
    expect(dice).toBeDefined();
    expect(dice!.state.maxValue).toBe(6);
    expect(dice!.state.faceMap).toEqual(D6_FACE_MAP);
  });

  test('d20 spawns with prim:d20 mesh + 20-face dice map + ConvexPolyhedron body', () => {
    const e = scene.spawn('d20', ctx);
    expect(e.type).toBe('d20');
    expect(e.tags).toEqual(['die']);
    const mesh = e.getComponent(MeshComponent)!;
    expect(mesh.state.meshRef).toBe('prim:d20');
    expect(mesh.meshKind()).toBe('icosahedron');
    const dice = e.getComponent(DiceComponent)!;
    expect(dice.state.maxValue).toBe(20);
    expect(dice.state.faceMap).toEqual(D20_FACE_MAP);
    const phys = e.getComponent(PhysicsComponent)!;
    expect(phys.body.shapes[0]).toBeInstanceOf(CANNON.ConvexPolyhedron);
    const hull = phys.body.shapes[0] as CANNON.ConvexPolyhedron;
    expect(hull.vertices).toHaveLength(12);
    expect(hull.faces).toHaveLength(20);
  });

  test('board spawns with transform/mesh/physics; no value', () => {
    const e = scene.spawn('board', ctx);
    expect(e.type).toBe('board');
    expect(e.tags).toEqual(['board']);
    expect(e.getComponent(ValueComponent)).toBeUndefined();
    const ms = e.getComponent(MeshComponent)!.state;
    expect([ms.width, ms.height, ms.depth]).toEqual([4, 0.05, 3]);
  });

  test('token spawns with meeple primitive + blue tint', () => {
    const e = scene.spawn('token', ctx);
    expect(e.getComponent(MeshComponent)!.state.meshRef).toBe('prim:meeple');
    expect(e.getComponent(MeshComponent)!.state.color).toBe('#2266cc');
  });

  test('default name format `${label}-${guid.slice(0,8)}`', () => {
    const e = scene.spawn('die', ctx);
    expect(e.name).toMatch(/^Die \(D6\)-[0-9a-f]{8}$/);
  });

  test('onSpawn builds the THREE Object3D and CANNON Body', () => {
    const e = scene.spawn('die', ctx);
    const t = e.getComponent(TransformComponent)!;
    const p = e.getComponent(PhysicsComponent)!;
    expect(t.object3d).toBeInstanceOf(THREE.Object3D);
    expect(t.object3d.parent).toBe(ctx.scene);
    expect(p.body).toBeDefined();
    expect(ctx.physics!.world.bodies).toContain(p.body);
  });

  test('explicit id round-trips through spawn', () => {
    const e = scene.spawn('die', ctx, { id: 'fixed-id' });
    expect(e.id).toBe('fixed-id');
    expect(scene.getEntity('fixed-id')).toBe(e);
  });
});

describe('spawnables — replicate (state mutation)', () => {
  test('Transform.setState merges + updates Object3D pose', () => {
    const e = scene.spawn('die', ctx);
    const t = e.getComponent(TransformComponent)!;
    t.setState({ position: [5, 6, 7], rotation: t.state.rotation, scale: t.state.scale });
    expect(t.state.position).toEqual([5, 6, 7]);
    expect(t.object3d.position.x).toBe(5);
    expect(t.object3d.position.y).toBe(6);
    expect(t.object3d.position.z).toBe(7);
  });

  test('Mesh.setState rebuilds the geometry on meshRef/size change', () => {
    const e = scene.spawn('board', ctx);
    const m = e.getComponent(MeshComponent)!;
    const before = m.group.children[0];
    m.setState({ width: 6, height: 0.05, depth: 4 });
    const after = m.group.children[0];
    expect(after).not.toBe(before);  // rebuilt
  });

  test('Physics state changes propagate to the CANNON body', () => {
    const e = scene.spawn('die', ctx);
    const p = e.getComponent(PhysicsComponent)!;
    p.setState({ mass: 2 });
    expect(p.body.mass).toBe(2);
  });

  test('Value.setState merges value + isNumeric', () => {
    const e = scene.spawn('die', ctx);
    const v = e.getComponent(ValueComponent)!;
    v.setState({ value: '3', isNumeric: true });
    expect(v.state.value).toBe('3');
    expect(v.asNumber()).toBe(3);
  });
});

describe('spawnables — despawn tears down view artefacts', () => {
  test('despawning a die removes Object3D from scene + body from physics', () => {
    const e = scene.spawn('die', ctx);
    const t = e.getComponent(TransformComponent)!;
    const p = e.getComponent(PhysicsComponent)!;
    expect(t.object3d.parent).toBe(ctx.scene);
    scene.despawn(e.id, ctx);
    expect(t.object3d.parent).toBeNull();
    expect(ctx.physics!.world.bodies).not.toContain(p.body);
    expect(scene.getEntity(e.id)).toBeUndefined();
  });

  test('despawn returns the cascade-deleted ids in order', () => {
    const e = scene.spawn('die', ctx);
    const removed = scene.despawn(e.id, ctx);
    expect(removed).toEqual([e.id]);
  });
});

describe('MeshComponent — prim:card', () => {
  test('builds a 3-material mesh with face/back/side slots', () => {
    const e = scene.spawn('board', ctx);
    const m = e.getComponent(MeshComponent)!;
    m.setState({ meshRef: 'prim:card', width: 0.63, height: 0.01, depth: 0.88 });

    const cardMesh = m.group.children[0] as THREE.Mesh;
    expect(cardMesh).toBeInstanceOf(THREE.Mesh);
    expect(Array.isArray(cardMesh.material)).toBe(true);

    const mats = cardMesh.material as THREE.Material[];
    expect(mats).toHaveLength(3);
    expect(mats[0].userData.materialSlot).toBe('face');
    expect(mats[1].userData.materialSlot).toBe('back');
    expect(mats[2].userData.materialSlot).toBe('side');
  });

  test('BoxGeometry groups remap +Y to face, -Y to back, sides shared', () => {
    const e = scene.spawn('board', ctx);
    const m = e.getComponent(MeshComponent)!;
    m.setState({ meshRef: 'prim:card', width: 0.63, height: 0.01, depth: 0.88 });

    const cardMesh = m.group.children[0] as THREE.Mesh;
    const groups = (cardMesh.geometry as THREE.BoxGeometry).groups;
    // BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z
    expect(groups[2].materialIndex).toBe(0); // +Y → face
    expect(groups[3].materialIndex).toBe(1); // -Y → back
    expect(groups[0].materialIndex).toBe(2); // +X → side
    expect(groups[1].materialIndex).toBe(2); // -X → side
    expect(groups[4].materialIndex).toBe(2); // +Z → side
    expect(groups[5].materialIndex).toBe(2); // -Z → side
  });

  test('halfExtents derives from card dimensions; meshKind reports cube', () => {
    const e = scene.spawn('board', ctx);
    const m = e.getComponent(MeshComponent)!;
    m.setState({ meshRef: 'prim:card', width: 0.63, height: 0.01, depth: 0.88 });
    expect(m.halfExtents()).toEqual([0.315, 0.005, 0.44]);
    expect(m.meshKind()).toBe('cube');
  });

  test('face/back textureRefs route to the correct materials', () => {
    const e = scene.spawn('board', ctx);
    const m = e.getComponent(MeshComponent)!;
    m.setState({
      meshRef: 'prim:card',
      width: 0.63, height: 0.01, depth: 0.88,
      textureRefs: { face: 'face.png', back: 'back.png' },
      color: '#ff0000',
    });

    const cardMesh = m.group.children[0] as THREE.Mesh;
    const mats = cardMesh.material as THREE.MeshLambertMaterial[];
    // Tint applies to all materials regardless of slot.
    expect(mats[0].color.getHexString()).toBe('ff0000');
    expect(mats[1].color.getHexString()).toBe('ff0000');
    expect(mats[2].color.getHexString()).toBe('ff0000');
    // Texture loading is async via THREE.TextureLoader and unobservable in
    // node, but slot tagging guarantees the right material would receive
    // the right URL — covered by mat.userData.materialSlot above.
  });
});

describe('spawnables — serialised snapshot shape', () => {
  test('die EntitySerialized matches expected shape', () => {
    const e = scene.spawn('die', ctx, { id: 'die-1' });
    const snap: EntitySerialized = entityToSerialized(e);
    expect(snap.id).toBe('die-1');
    expect(snap.type).toBe('die');
    expect(snap.tags).toEqual(['die']);
    expect(snap.owner).toBeNull();
    expect(snap.privateToSeat).toBeNull();
    expect(snap.parentId).toBeNull();
    expect(snap.children).toEqual([]);
    expect(Object.keys(snap.components).sort()).toEqual(['dice', 'mesh', 'physics', 'transform', 'tween', 'value']);
    expect(snap.components.value).toEqual({ value: '6', isNumeric: true });
    expect(snap.components.physics).toEqual({ mass: 0.2, friction: 0.5, restitution: 0.5, isLocked: false, yawOnly: false });
    expect(snap.components.mesh).toMatchObject({ meshRef: 'prim:d6', width: 0.7, height: 0.7, depth: 0.7 });
    expect(snap.components.dice).toEqual({ maxValue: 6, faceMap: D6_FACE_MAP });
  });

  test('snapshot round-trips JSON without loss', () => {
    const e = scene.spawn('token', ctx, { id: 'tok-1' });
    const original = entityToSerialized(e);
    const cloned: EntitySerialized = JSON.parse(JSON.stringify(original));
    expect(cloned).toEqual(original);
  });
});

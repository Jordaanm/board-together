import { describe, test, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { SceneImpl } from '../Scene';
import { type SpawnContext, type ActionContext, type MenuItem } from '../EntityComponent';
import { aggregateContextMenu } from '../contextMenu';
import { registerCorePrimitives } from '../spawnables';
import { PhysicsWorld } from '../../physics/PhysicsWorld';
import { Entity } from '../Entity';
import { MeshComponent, type MeshState } from './MeshComponent';
import { TransformComponent } from './TransformComponent';
import { TweenComponent } from './TweenComponent';
import { DEFAULT_PREFERENCES } from '../../preferences/types';

let scene: SceneImpl;
let ctx: SpawnContext;

beforeEach(() => {
  registerCorePrimitives();
  scene = new SceneImpl();
  ctx = { scene: new THREE.Scene(), physics: new PhysicsWorld(), entityScene: scene };
});

describe('MeshComponent — meshRef branches', () => {
  test('primitive meshRef builds a non-empty group via buildMesh', () => {
    const e = scene.spawn('token', ctx);
    const mesh = e.getComponent(MeshComponent)!;
    expect(mesh.state.meshRef).toBe('prim:meeple');
    expect(mesh.group.children.length).toBeGreaterThan(0);
  });

  test('switching meshRef to a non-prim slug subscribes via AssetService and adds the placeholder', () => {
    const e = scene.spawn('token', ctx);
    const mesh = e.getComponent(MeshComponent)!;
    mesh.setState({ meshRef: 'custom:knight' });
    // Synchronous: the AssetService subscribe fires immediately with the
    // placeholder cube before any network resolution completes.
    expect(mesh.group.children.length).toBe(1);
    const child = mesh.group.children[0];
    expect(child).toBeInstanceOf(THREE.Object3D);
  });

  test('switching back to a prim ref restores the primitive geometry', () => {
    const e = scene.spawn('token', ctx);
    const mesh = e.getComponent(MeshComponent)!;
    mesh.setState({ meshRef: 'custom:knight' });
    mesh.setState({ meshRef: 'prim:cube' });
    expect(mesh.state.meshRef).toBe('prim:cube');
    // prim:cube is a single mesh — verify the group holds it.
    expect(mesh.group.children.length).toBe(1);
  });
});

describe('MeshComponent — prim:plane', () => {
  function spawnPlane(state: Partial<MeshState> = {}): { entity: Entity; mesh: MeshComponent } {
    const entity = new Entity({ id: 'p-1', type: 'plane', name: 'Plane' });
    const transform = new TransformComponent();
    transform.fromJSON({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    entity.attachComponent(transform);
    const mesh = new MeshComponent();
    mesh.fromJSON({
      meshRef:     'prim:plane',
      textureRefs: { default: '' },
      color:        '#ffffff',
      width: 2, height: 0.01, depth: 3,
      ...state,
    });
    entity.attachComponent(mesh);
    transform.onSpawn(ctx);
    mesh.onSpawn(ctx);
    return { entity, mesh };
  }

  test('builds a single-mesh group with PlaneGeometry sized from size[0] × size[2]', () => {
    const { mesh } = spawnPlane();
    expect(mesh.group.children.length).toBe(1);
    const child = mesh.group.children[0] as THREE.Mesh;
    expect(child).toBeInstanceOf(THREE.Mesh);
    expect(child.geometry).toBeInstanceOf(THREE.PlaneGeometry);
    const params = (child.geometry as THREE.PlaneGeometry).parameters;
    expect(params.width).toBe(2);
    expect(params.height).toBe(3);
  });

  test('halfExtents returns [w/2, d/2, 0]; size[1] (height) is ignored', () => {
    const { mesh } = spawnPlane({ width: 4, height: 99, depth: 6 });
    expect(mesh.halfExtents()).toEqual([2, 3, 0]);
  });

  test('default PlaneGeometry UVs paired with flipY=true CanvasTexture put canvas top-left at visual top when viewed from +Z', () => {
    const { mesh } = spawnPlane();
    const child = mesh.group.children[0] as THREE.Mesh;
    const uv = (child.geometry as THREE.PlaneGeometry).attributes.uv as THREE.BufferAttribute;
    // PlaneGeometry default vertex order: top-left, top-right, bottom-left,
    // bottom-right where +Y is up. Default UVs put V=1 at top-left; with
    // flipY=true (CanvasTexture default) V=1 samples canvas y=0, so canvas
    // top-left lands at the plane's top-left vertex.
    expect(uv.getX(0)).toBe(0);
    expect(uv.getY(0)).toBe(1);
  });

  test('round-trip: toJSON → fromJSON identity', () => {
    const { mesh } = spawnPlane({ color: '#abcdef', textureRefs: { default: 'base:tex/foo' } });
    const json = mesh.toJSON();

    const fresh = new MeshComponent();
    fresh.fromJSON(json);
    expect(fresh.toJSON()).toEqual(json);
  });

  test('tint change applies via onPropertiesChanged when applyTint is on', () => {
    const { mesh } = spawnPlane({ applyTint: true });
    mesh.setState({ color: '#ff0000' });
    const child = mesh.group.children[0] as THREE.Mesh;
    const mat   = child.material as THREE.MeshLambertMaterial;
    expect(mat.color.getHexString()).toBe('ff0000');
  });

  test('tint is ignored when applyTint is off (default)', () => {
    const { mesh } = spawnPlane();
    mesh.setState({ color: '#ff0000' });
    const child = mesh.group.children[0] as THREE.Mesh;
    const mat   = child.material as THREE.MeshLambertMaterial;
    expect(mat.color.getHexString()).toBe('ffffff');
  });

  test('textureRefs.default routes through applyMaterialAttributes (placeholder texture installed)', () => {
    const { mesh } = spawnPlane({ textureRefs: { default: 'base:tex/foo' } });
    const child = mesh.group.children[0] as THREE.Mesh;
    const mat   = child.material as THREE.MeshLambertMaterial;
    // AssetService subscribe fires synchronously with a placeholder texture.
    expect(mat.map).not.toBeNull();
  });

  test('despawn cleans up children and texture subscriptions', () => {
    const { mesh } = spawnPlane({ textureRefs: { default: 'base:tex/foo' } });
    mesh.onDespawn(ctx);
    // Group is detached from any parent it had been added to.
    expect(mesh.group.parent).toBeNull();
  });
});

describe('MeshComponent — prim:page', () => {
  function spawnPage(state: Partial<MeshState> = {}): { entity: Entity; mesh: MeshComponent } {
    const entity = new Entity({ id: 'pg-1', type: 'pdf', name: 'Page' });
    const transform = new TransformComponent();
    transform.fromJSON({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    entity.attachComponent(transform);
    const mesh = new MeshComponent();
    mesh.fromJSON({
      meshRef:     'prim:page',
      textureRefs: { face: '', back: '', side: '' },
      color:       '#ffffff',
      width: 1.0, height: 0.02, depth: 1.29,
      ...state,
    });
    entity.attachComponent(mesh);
    transform.onSpawn(ctx);
    mesh.onSpawn(ctx);
    return { entity, mesh };
  }

  test('builds a single BoxGeometry mesh with three materials and sharp corners', () => {
    const { mesh } = spawnPage();
    expect(mesh.group.children.length).toBe(1);
    const child = mesh.group.children[0] as THREE.Mesh;
    expect(child).toBeInstanceOf(THREE.Mesh);
    // BoxGeometry — sharp corners. RoundedBoxGeometry would surface its own
    // class on the geometry property.
    expect(child.geometry.constructor.name).toBe('BoxGeometry');
    expect(Array.isArray(child.material)).toBe(true);
    expect((child.material as THREE.Material[]).length).toBe(3);
  });

  test('face/back/side material slots map to +Y / -Y / sides (mirrors prim:card)', () => {
    const { mesh } = spawnPage();
    const child = mesh.group.children[0] as THREE.Mesh;
    const mats  = child.material as THREE.Material[];
    expect(mats[0].userData.materialSlot).toBe('face');
    expect(mats[1].userData.materialSlot).toBe('back');
    expect(mats[2].userData.materialSlot).toBe('side');
    const groups = child.geometry.groups;
    expect(groups[2].materialIndex).toBe(0); // +Y → face
    expect(groups[3].materialIndex).toBe(1); // -Y → back
    expect(groups[0].materialIndex).toBe(2); // +X → side
    expect(groups[4].materialIndex).toBe(2); // +Z → side
  });

  test('halfExtents returns [width/2, height/2, depth/2]', () => {
    const { mesh } = spawnPage({ width: 1.0, height: 0.02, depth: 1.29 });
    expect(mesh.halfExtents()).toEqual([0.5, 0.01, 0.645]);
  });

  test('meshKind returns "cube"', () => {
    const { mesh } = spawnPage();
    expect(mesh.meshKind()).toBe('cube');
  });

  test('hitbox follows width/height/depth changes', () => {
    const { mesh } = spawnPage();
    mesh.setState({ width: 2, height: 0.04, depth: 2.58 });
    expect(mesh.halfExtents()).toEqual([1, 0.02, 1.29]);
    // After dimension change, MeshComponent rebuilds the group so the
    // BoxGeometry parameters track the new dims.
    const child = mesh.group.children[0] as THREE.Mesh;
    const params = (child.geometry as THREE.BoxGeometry).parameters;
    expect(params.width).toBe(2);
    expect(params.height).toBe(0.04);
    expect(params.depth).toBe(2.58);
  });
});

describe('MeshComponent — isContained visibility', () => {
  test('group.visible is true on spawn when entity is not contained', () => {
    const e = scene.spawn('card', ctx);
    const mesh = e.getComponent(MeshComponent)!;
    expect(mesh.group.visible).toBe(true);
  });

  test('group.visible is false on spawn when entity is contained', () => {
    const e = scene.spawn('card', ctx);
    e.isContained = true;
    // Re-fire visibility — simulates a load that started with isContained=true.
    e.getComponent(MeshComponent)!.onIsContainedChanged(true);
    expect(e.getComponent(MeshComponent)!.group.visible).toBe(false);
  });

  test('onIsContainedChanged toggles group.visible', () => {
    const e = scene.spawn('card', ctx);
    const mesh = e.getComponent(MeshComponent)!;
    expect(mesh.group.visible).toBe(true);

    mesh.onIsContainedChanged(true);
    expect(mesh.group.visible).toBe(false);

    mesh.onIsContainedChanged(false);
    expect(mesh.group.visible).toBe(true);
  });
});

describe('MeshComponent — rotate actions', () => {
  beforeEach(() => {
    // load() warns when localStorage is unavailable (node env); silence the
    // expected warnings so they don't clutter test output.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  test('context menu includes Rotate / Rotate Counter Clockwise items', () => {
    const e = scene.spawn('card', ctx);
    const items = aggregateContextMenu(e, {
      recipientSeat: 0, isHost: true, entity: e,
      preferences:   DEFAULT_PREFERENCES,
    });
    const meshItems = items.filter(
      i => i.kind === 'action' && (i as { componentTypeId?: string }).componentTypeId === 'mesh',
    ) as Array<MenuItem & { kind: 'action' }>;
    const cw  = meshItems.find(i => i.id === 'rotate-cw')!;
    const ccw = meshItems.find(i => i.id === 'rotate-ccw')!;
    expect(cw.label).toBe('Rotate');
    expect(ccw.label).toBe('Rotate Counter Clockwise');
  });

  test('rotate items suppressed when a DiceComponent is attached', () => {
    const e = scene.spawn('die', ctx);
    const items = aggregateContextMenu(e, {
      recipientSeat: 0, isHost: true, entity: e,
      preferences:   DEFAULT_PREFERENCES,
    });
    const meshRotates = items.filter(
      i => i.kind === 'action'
        && (i as { componentTypeId?: string }).componentTypeId === 'mesh'
        && ((i as { id: string }).id === 'rotate-cw' || (i as { id: string }).id === 'rotate-ccw'),
    );
    expect(meshRotates).toEqual([]);
  });

  test('rotate items omitted from getActions when the entity has no TweenComponent', () => {
    // prim:cube spawnable (token has tween; we hand-build an entity with no tween).
    const entity = new Entity({ id: 'mesh-only', type: 'thing', name: 'thing' });
    const transform = new TransformComponent();
    transform.fromJSON({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    entity.attachComponent(transform);
    const mesh = new MeshComponent();
    mesh.fromJSON({
      meshRef: 'prim:cube', textureRefs: {}, color: '#fff',
      width: 1, height: 1, depth: 1,
    });
    entity.attachComponent(mesh);
    const out = mesh.getActions({
      recipientSeat: 0, isHost: true, entity,
      preferences:   DEFAULT_PREFERENCES,
    });
    const names = out.map(d => d.name);
    expect(names).not.toContain('rotate-cw');
    expect(names).not.toContain('rotate-ccw');
  });

  test('rotate-cw rotates clockwise about world +Y by ctx.preferences.rotateAmount (negative angle)', () => {
    const e = scene.spawn('card', ctx);
    const mesh      = e.getComponent(MeshComponent)!;
    const transform = e.getComponent(TransformComponent)!;
    const actionCtx: ActionContext = {
      recipientSeat: null, isHost: true, entity: e,
      preferences:   { ...DEFAULT_PREFERENCES, rotateAmount: 90 },
    };
    mesh.onAction('rotate-cw', actionCtx);
    // Tween snaps to its target via World during snapshot; force it here.
    e.getComponent(TweenComponent)!.snapToTarget();
    const [qx, qy, qz, qw] = transform.state.rotation;
    // Apply quaternion to a +X unit vector. CW rotation about Y (looking down)
    // moves +X to +Z in right-handed THREE coords.
    const v = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion(qx, qy, qz, qw));
    expect(v.x).toBeCloseTo(0,  5);
    expect(v.y).toBeCloseTo(0,  5);
    expect(v.z).toBeCloseTo(1,  5);
  });

  test('rotate-ccw rotates counter-clockwise about world +Y (positive angle)', () => {
    const e = scene.spawn('card', ctx);
    const mesh      = e.getComponent(MeshComponent)!;
    const transform = e.getComponent(TransformComponent)!;
    const actionCtx: ActionContext = {
      recipientSeat: null, isHost: true, entity: e,
      preferences:   { ...DEFAULT_PREFERENCES, rotateAmount: 90 },
    };
    mesh.onAction('rotate-ccw', actionCtx);
    e.getComponent(TweenComponent)!.snapToTarget();
    const [qx, qy, qz, qw] = transform.state.rotation;
    const v = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion(qx, qy, qz, qw));
    expect(v.x).toBeCloseTo( 0, 5);
    expect(v.y).toBeCloseTo( 0, 5);
    expect(v.z).toBeCloseTo(-1, 5);
  });
});

describe('MeshComponent — propertySchema (issue #2 of property-schema-refactor)', () => {
  test('declares static label and color/meshRef/textureUrl entries', () => {
    expect(MeshComponent.label).toBe('Mesh');
    const keys = MeshComponent.propertySchema.map(d => d.key);
    expect(keys).toEqual(['color', 'applyTint', 'meshRef', 'textureUrl', 'width', 'height', 'depth']);
  });

  test('textureUrl adapter get returns the default ref', () => {
    const def = MeshComponent.propertySchema.find(d => d.key === 'textureUrl')!;
    const state: MeshState = {
      meshRef: 'prim:cube',
      textureRefs: { default: 'base:tex/foo', face: 'unrelated' },
      color: '#fff',
      width: 1, height: 1, depth: 1,
    };
    expect(def.get!(state, undefined as never)).toBe('base:tex/foo');
  });

  test('textureUrl adapter get returns empty string when missing', () => {
    const def = MeshComponent.propertySchema.find(d => d.key === 'textureUrl')!;
    const state: MeshState = {
      meshRef: 'prim:cube',
      textureRefs: {},
      color: '#fff',
      width: 1, height: 1, depth: 1,
    };
    expect(def.get!(state, undefined as never)).toBe('');
  });

  test('textureUrl adapter set merges into the textureRefs map preserving siblings', () => {
    const def = MeshComponent.propertySchema.find(d => d.key === 'textureUrl')!;
    const state: MeshState = {
      meshRef: 'prim:card',
      textureRefs: { default: 'old', face: 'F.png', back: 'B.png' },
      color: '#fff',
      width: 1, height: 1, depth: 1,
    };
    const patch = def.set!('new.png', state, undefined as never);
    expect(patch).toEqual({
      textureRefs: { default: 'new.png', face: 'F.png', back: 'B.png' },
    });
  });
});

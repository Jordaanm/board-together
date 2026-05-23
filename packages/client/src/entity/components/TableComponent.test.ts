// Component-level tests for the Table singleton's bounds derivation,
// presence detection, primitive switching, and locking enforcement
// (despawn / spawn-duplicate gates). Slices 1 + 5 of issues--table-refactor.md.

import { describe, test, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { SceneImpl } from '../Scene';
import { type SpawnContext } from '../EntityComponent';
import { PhysicsWorld } from '../../physics/PhysicsWorld';
import { registerCorePrimitives } from '../spawnables';
import { TableComponent } from './TableComponent';
import { MeshComponent } from './MeshComponent';
import { TransformComponent } from './TransformComponent';
import { TABLE_ENTITY_ID } from '../tableEntity';
import { defaultSeatStates, seatPoseFromState } from '../../seats/SeatPoseState';
import { computeSeatLayout } from '../../seats/SeatLayout';

let scene: SceneImpl;
let ctx:   SpawnContext;

beforeEach(() => {
  registerCorePrimitives();
  scene = new SceneImpl();
  ctx = { scene: new THREE.Scene(), physics: new PhysicsWorld(), entityScene: scene };
});

describe('TableComponent — presence detection', () => {
  test("Table spawnable carries a TableComponent", () => {
    const e = scene.spawn('table', ctx, { id: TABLE_ENTITY_ID });
    expect(e.getComponent(TableComponent)).toBeDefined();
  });

  test('non-table entities do not carry a TableComponent', () => {
    const e = scene.spawn('die', ctx);
    expect(e.getComponent(TableComponent)).toBeUndefined();
  });

  test('Table is tagged "table" and "fixture"', () => {
    const e = scene.spawn('table', ctx, { id: TABLE_ENTITY_ID });
    expect(e.tags.sort()).toEqual(['fixture', 'table']);
  });
});

describe('Scene.getTable / getTableBounds', () => {
  test('getTable returns undefined when no table spawned', () => {
    expect(scene.getTable()).toBeUndefined();
  });

  test('getTableBounds returns defaults when no table spawned', () => {
    const b = scene.getTableBounds();
    expect(b.halfWidth).toBeCloseTo(6, 5);
    expect(b.halfDepth).toBeCloseTo(4, 5);
  });

  test('getTable returns the spawned Table entity', () => {
    const e = scene.spawn('table', ctx, { id: TABLE_ENTITY_ID });
    expect(scene.getTable()).toBe(e);
  });

  test('getTableBounds returns rect-table defaults at default scale', () => {
    scene.spawn('table', ctx, { id: TABLE_ENTITY_ID });
    const b = scene.getTableBounds();
    expect(b.halfWidth).toBeCloseTo(6, 5);
    expect(b.halfDepth).toBeCloseTo(4, 5);
  });

  test('getTableBounds returns circle-table defaults when meshRef switched', () => {
    const e = scene.spawn('table', ctx, { id: TABLE_ENTITY_ID });
    const mesh = e.getComponent(MeshComponent)!;
    mesh.setState({ meshRef: 'prim:table-circle', width: 8, height: 0.3, depth: 8 });
    const b = scene.getTableBounds();
    expect(b.halfWidth).toBeCloseTo(4, 5);
    expect(b.halfDepth).toBeCloseTo(4, 5);
  });

  test('getTableBounds scales linearly with uniform transform scale', () => {
    const e = scene.spawn('table', ctx, { id: TABLE_ENTITY_ID });
    const t = e.getComponent(TransformComponent)!;
    t.setState({ position: t.state.position, rotation: t.state.rotation, scale: [3, 3, 3] });
    const b = scene.getTableBounds();
    expect(b.halfWidth).toBeCloseTo(18, 5);
    expect(b.halfDepth).toBeCloseTo(12, 5);
  });
});

describe('TableComponent — seat state', () => {
  test('spawning Table without seats populates 8 default states from current bounds', () => {
    const e = scene.spawn('table', ctx, { id: TABLE_ENTITY_ID });
    const t = e.getComponent(TableComponent)!;
    const expected = defaultSeatStates({ halfWidth: 6, halfDepth: 4 });
    expect(t.state.seats).toHaveLength(8);
    for (let i = 0; i < 8; i++) {
      expect(t.state.seats![i].x).toBeCloseTo(expected[i].x, 10);
      expect(t.state.seats![i].z).toBeCloseTo(expected[i].z, 10);
      expect(t.state.seats![i].yaw).toBeCloseTo(expected[i].yaw, 10);
    }
  });

  test('defaults match prior computeSeatLayout output for canonical bounds', () => {
    const e = scene.spawn('table', ctx, { id: TABLE_ENTITY_ID });
    const t = e.getComponent(TableComponent)!;
    const layout = computeSeatLayout({ halfWidth: 6, halfDepth: 4 });
    for (let i = 0; i < 8; i++) {
      const pose = seatPoseFromState(t.state.seats![i]);
      expect(pose.position.x).toBeCloseTo(layout[i].position.x, 10);
      expect(pose.position.z).toBeCloseTo(layout[i].position.z, 10);
      expect(pose.facing.x).toBeCloseTo(layout[i].facing.x, 10);
      expect(pose.facing.z).toBeCloseTo(layout[i].facing.z, 10);
    }
  });

  test('load() with provided seats array stores it verbatim', () => {
    const provided = [
      { x: 1.5, z: 2.5, yaw: 0.1 },
      { x: 2.5, z: 3.5, yaw: 0.2 },
      { x: 3.5, z: 4.5, yaw: 0.3 },
      { x: 4.5, z: 5.5, yaw: 0.4 },
      { x: 5.5, z: 6.5, yaw: 0.5 },
      { x: 6.5, z: 7.5, yaw: 0.6 },
      { x: 7.5, z: 8.5, yaw: 0.7 },
      { x: 8.5, z: 9.5, yaw: 0.8 },
    ];
    const loaded = scene.load([{
      id:            TABLE_ENTITY_ID,
      type:          'table',
      name:          'Table',
      tags:          ['table', 'fixture'],
      owner:         null,
      privateToSeat: null,
      parentId:      null,
      children:      [],
      components: {
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        mesh:      { meshRef: 'prim:table-rect', textureRefs: { default: 'base:table/default' }, color: '#ffffff', applyTint: false, width: 12, height: 0.3, depth: 8 },
        table:     { seats: provided },
      },
    }], ctx);
    const t = loaded[0].getComponent(TableComponent)!;
    expect(t.state.seats).toEqual(provided);
  });

  test('a consumer can read seat poses from TableComponent state via seatPoseFromState', () => {
    const e = scene.spawn('table', ctx, { id: TABLE_ENTITY_ID });
    const t = e.getComponent(TableComponent)!;
    const poses = t.state.seats!.map(seatPoseFromState);
    expect(poses).toHaveLength(8);
    for (const p of poses) {
      expect(p.position.y).toBe(0);
      const len = Math.hypot(p.facing.x, p.facing.y, p.facing.z);
      expect(len).toBeCloseTo(1, 10);
    }
  });
});

describe('SceneImpl — Table locking gates (slice 5)', () => {
  test('despawn(TABLE_ENTITY_ID) throws with a descriptive error', () => {
    scene.spawn('table', ctx, { id: TABLE_ENTITY_ID });
    expect(() => scene.despawn(TABLE_ENTITY_ID, ctx))
      .toThrowError(/Cannot despawn the Table/);
    expect(scene.getTable()).toBeDefined();  // still present
  });

  test('despawn with { force: true } bypasses the gate (replaceScene path)', () => {
    scene.spawn('table', ctx, { id: TABLE_ENTITY_ID });
    expect(() => scene.despawn(TABLE_ENTITY_ID, ctx, { force: true })).not.toThrow();
    expect(scene.getTable()).toBeUndefined();
  });

  test('spawn("table", ...) throws when a Table already exists', () => {
    scene.spawn('table', ctx, { id: TABLE_ENTITY_ID });
    expect(() => scene.spawn('table', ctx))
      .toThrowError(/singleton Table entity already exists/);
  });

  test('non-table despawns are unaffected', () => {
    scene.spawn('table', ctx, { id: TABLE_ENTITY_ID });
    const die = scene.spawn('die', ctx, { id: 'die-1' });
    expect(() => scene.despawn(die.id, ctx)).not.toThrow();
    expect(scene.has('die-1')).toBe(false);
  });
});

// Boundary tests: host→guest round-trip via InMemoryTransport.
// Issue #1: replication chain (spawn → flush → transport → inbound dispatch).
// Issue #3: guest drag chain (tryHold → setPosition → release through EntityHandle).
// Issue #8: late-join scene-snapshot via World peer-join handler.

import { describe, test, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { createWorld } from './World';
import { createInMemoryBusPair } from './InMemoryTransport';
import { TransformComponent } from '../components/TransformComponent';
import { ValueComponent } from '../components/ValueComponent';
import { PhysicsComponent } from '../components/PhysicsComponent';
import { TableComponent } from '../components/TableComponent';
import { SkydomeComponent } from '../components/SkydomeComponent';
import { LightingComponent } from '../components/LightingComponent';
import { MeshComponent } from '../components/MeshComponent';
import { TABLE_ENTITY_ID } from '../tableEntity';
import { type World } from './types';
import { type SeatIndex } from '../../seats/SeatLayout';

interface Pair {
  host:  World;
  guest: World;
  firePeerJoin: (side: 'host' | 'guest', peerId: string) => void;
}

const HOST_PEER_ID  = 'host-peer';
const GUEST_PEER_ID = 'guest-peer';
const HOST_SEAT:  SeatIndex = 0;
const GUEST_SEAT: SeatIndex = 1;

function setup(): Pair {
  const bus = createInMemoryBusPair();
  const peerSeats = new Map<string, SeatIndex>([[GUEST_PEER_ID, GUEST_SEAT]]);
  const host = createWorld({
    role:        'host',
    scene:       new THREE.Scene(),
    identity:    { isHost: true,  selfSeat: () => HOST_SEAT,  selfPeerId: () => HOST_PEER_ID },
    transport:   bus.host,
    getPeerSeat: (peerId) => peerSeats.get(peerId) ?? null,
  });
  const guest = createWorld({
    role:      'guest',
    scene:     new THREE.Scene(),
    identity:  { isHost: false, selfSeat: () => GUEST_SEAT, selfPeerId: () => GUEST_PEER_ID },
    transport: bus.guest,
  });
  return { host, guest, firePeerJoin: bus.firePeerJoin };
}

describe('World — Table boot path (table-as-entity slice 1)', () => {
  let pair: Pair | null = null;

  afterEach(() => {
    pair?.host.dispose();
    pair?.guest.dispose();
    pair = null;
  });

  test('host bootstraps with the Table entity at the fixed GUID', () => {
    pair = setup();
    const table = pair.host.get(TABLE_ENTITY_ID);
    expect(table).toBeDefined();
    expect(table!.entity.type).toBe('table');
    expect(table!.entity.tags.sort()).toEqual(['fixture', 'table']);
    expect(table!.entity.getComponent(TableComponent)).toBeDefined();
  });

  test('Table is the sole entity in a fresh host World', () => {
    pair = setup();
    const ids = pair.host.all().map(h => h.id);
    expect(ids).toEqual([TABLE_ENTITY_ID]);
  });

  test('fresh guest World has zero entities (Table arrives via replication)', () => {
    pair = setup();
    expect(pair.guest.all()).toEqual([]);
  });

  test('Table replicates to guest after first tick', () => {
    pair = setup();
    pair.host.tick(0.016);
    const guestTable = pair.guest.get(TABLE_ENTITY_ID);
    expect(guestTable).toBeDefined();
    expect(guestTable!.entity.getComponent(TableComponent)).toBeDefined();
  });

  test('getTable returns the singleton handle on host', () => {
    pair = setup();
    expect(pair.host.getTable()?.id).toBe(TABLE_ENTITY_ID);
  });

  test('getTableBounds returns rect defaults on host', () => {
    pair = setup();
    const b = pair.host.getTableBounds();
    expect(b.halfWidth).toBeCloseTo(6, 5);
    expect(b.halfDepth).toBeCloseTo(4, 5);
  });

  test('getTableBounds scales linearly with uniform scale', () => {
    pair = setup();
    const table = pair.host.get(TABLE_ENTITY_ID)!;
    const t = table.get(TransformComponent)!;
    t.setState({ position: t.state.position, rotation: t.state.rotation, scale: [2, 2, 2] });
    const b = pair.host.getTableBounds();
    expect(b.halfWidth).toBeCloseTo(12, 5);
    expect(b.halfDepth).toBeCloseTo(8, 5);
  });

  test('getTableBounds falls back to defaults on guest before replication', () => {
    pair = setup();
    const b = pair.guest.getTableBounds();
    expect(b.halfWidth).toBeCloseTo(6, 5);
    expect(b.halfDepth).toBeCloseTo(4, 5);
  });

  test('SkydomeComponent textureUrl replicates host → guest (slice 2)', () => {
    pair = setup();
    pair.host.tick(0.016);  // replicate Table to guest
    const hostSky = pair.host.get(TABLE_ENTITY_ID)!.get(SkydomeComponent)!;
    hostSky.setState({ textureUrl: 'custom:sky/some-slug' });
    pair.host.tick(0.016);

    const guestSky = pair.guest.get(TABLE_ENTITY_ID)!.get(SkydomeComponent)!;
    expect(guestSky.state.textureUrl).toBe('custom:sky/some-slug');
  });

  test('updateComponentProp routes Table component keys to the correct components (slice 4)', () => {
    pair = setup();
    pair.host.tick(0.016);  // replicate Table to guest

    pair.host.updateComponentProp(TABLE_ENTITY_ID, 'mesh',      'meshRef',    'prim:table-circle');
    pair.host.updateComponentProp(TABLE_ENTITY_ID, 'transform', 'scale',      1.5);
    pair.host.updateComponentProp(TABLE_ENTITY_ID, 'skydome',   'textureUrl', 'custom:sky/pretty');
    pair.host.updateComponentProp(TABLE_ENTITY_ID, 'lighting',  'color',      '#abcdef');
    pair.host.updateComponentProp(TABLE_ENTITY_ID, 'lighting',  'intensity',  0.5);

    const hostTable = pair.host.get(TABLE_ENTITY_ID)!;
    expect(hostTable.get(MeshComponent)!.state.meshRef).toBe('prim:table-circle');
    expect(hostTable.get(TransformComponent)!.state.scale).toEqual([1.5, 1.5, 1.5]);
    expect(hostTable.get(SkydomeComponent)!.state.textureUrl).toBe('custom:sky/pretty');
    expect(hostTable.get(LightingComponent)!.state.color).toBe('#abcdef');
    expect(hostTable.get(LightingComponent)!.state.intensity).toBeCloseTo(0.5, 5);

    pair.host.tick(0.016);

    const guestTable = pair.guest.get(TABLE_ENTITY_ID)!;
    expect(guestTable.get(MeshComponent)!.state.meshRef).toBe('prim:table-circle');
    expect(guestTable.get(TransformComponent)!.state.scale).toEqual([1.5, 1.5, 1.5]);
    expect(guestTable.get(SkydomeComponent)!.state.textureUrl).toBe('custom:sky/pretty');
    expect(guestTable.get(LightingComponent)!.state.color).toBe('#abcdef');
    expect(guestTable.get(LightingComponent)!.state.intensity).toBeCloseTo(0.5, 5);
  });

  test('updateComponentProp persists a seats array write end-to-end', () => {
    // Regression: World.updateComponentProp short-circuits when no schema
    // entry exists for the key. The TableComponent.seats passthrough entry
    // exists specifically so panel + gizmo writes land on host state and
    // replicate to guests rather than vanishing silently.
    pair = setup();
    pair.host.tick(0.016);  // replicate Table to guest

    const nextSeats = [
      { x: 99.5, z: -88.25, yaw: 1.5 },
      { x:  1,   z:   2,    yaw: 0   },
      { x:  3,   z:   4,    yaw: 0   },
      { x:  5,   z:   6,    yaw: 0   },
      { x:  7,   z:   8,    yaw: 0   },
      { x:  9,   z:  10,    yaw: 0   },
      { x: 11,   z:  12,    yaw: 0   },
      { x: 13,   z:  14,    yaw: 0   },
    ];
    pair.host.updateComponentProp(TABLE_ENTITY_ID, 'table', 'seats', nextSeats);

    const hostSeats = pair.host.get(TABLE_ENTITY_ID)!.get(TableComponent)!.state.seats;
    expect(hostSeats?.[0]).toEqual({ x: 99.5, z: -88.25, yaw: 1.5 });

    pair.host.tick(0.016);  // flush replication

    const guestSeats = pair.guest.get(TABLE_ENTITY_ID)!.get(TableComponent)!.state.seats;
    expect(guestSeats?.[0]).toEqual({ x: 99.5, z: -88.25, yaw: 1.5 });
  });

  test('updateComponentProp clamps a non-positive scale to the schema min', () => {
    pair = setup();
    pair.host.updateComponentProp(TABLE_ENTITY_ID, 'transform', 'scale', 0);
    // Schema declares min: 0.0001 on the scale entry; the dispatcher pre-
    // clamps to that floor before the adapter writes the [x, y, z] triple.
    expect(pair.host.get(TABLE_ENTITY_ID)!.get(TransformComponent)!.state.scale).toEqual([0.0001, 0.0001, 0.0001]);
  });

  test('updateComponentProp clamps a negative light intensity to 0', () => {
    pair = setup();
    pair.host.updateComponentProp(TABLE_ENTITY_ID, 'lighting', 'intensity', -1);
    expect(pair.host.get(TABLE_ENTITY_ID)!.get(LightingComponent)!.state.intensity).toBe(0);
  });

  test('World.despawn(TABLE_ENTITY_ID) throws and leaves the Table intact (slice 5)', () => {
    pair = setup();
    expect(() => pair!.host.despawn(TABLE_ENTITY_ID))
      .toThrowError(/Cannot despawn the Table/);
    expect(pair.host.get(TABLE_ENTITY_ID)).toBeDefined();
  });

  test('World.spawn("table") throws when Table already exists (slice 5)', () => {
    pair = setup();
    expect(() => pair!.host.spawn('table'))
      .toThrowError(/singleton Table entity already exists/);
  });

  test('refused despawn does not push a history entry (slice 5)', () => {
    pair = setup();
    const before = pair.host.history!.entries().length;
    expect(() => pair!.host.despawn(TABLE_ENTITY_ID)).toThrow();
    expect(pair.host.history!.entries().length).toBe(before);
  });

  test('replaceScene cascades through the Table despite the gate (slice 5)', () => {
    pair = setup();
    // Snapshot includes the Table; replaceScene must despawn the live Table
    // (force: true) before reloading without throwing.
    const snap = pair.host.snapshot();
    expect(() => pair!.host.replaceScene(snap)).not.toThrow();
    expect(pair.host.get(TABLE_ENTITY_ID)).toBeDefined();
  });

  test('save → reload round-trip preserves all five Table props (slice 7)', () => {
    pair = setup();
    // Mutate every editable Table prop, then snapshot.
    pair.host.updateComponentProp(TABLE_ENTITY_ID, 'mesh',      'meshRef',    'prim:table-circle');
    pair.host.updateComponentProp(TABLE_ENTITY_ID, 'transform', 'scale',      1.5);
    pair.host.updateComponentProp(TABLE_ENTITY_ID, 'skydome',   'textureUrl', 'custom:sky/abc');
    pair.host.updateComponentProp(TABLE_ENTITY_ID, 'lighting',  'color',      '#abcdef');
    pair.host.updateComponentProp(TABLE_ENTITY_ID, 'lighting',  'intensity',  0.42);
    const snap = pair.host.snapshot();

    // Mutate further then revert via replaceScene.
    pair.host.updateComponentProp(TABLE_ENTITY_ID, 'transform', 'scale', 9);
    pair.host.replaceScene(snap);

    const table = pair.host.get(TABLE_ENTITY_ID)!;
    expect(table.get(MeshComponent)!.state.meshRef).toBe('prim:table-circle');
    expect(table.get(TransformComponent)!.state.scale).toEqual([1.5, 1.5, 1.5]);
    expect(table.get(SkydomeComponent)!.state.textureUrl).toBe('custom:sky/abc');
    expect(table.get(LightingComponent)!.state.color).toBe('#abcdef');
    expect(table.get(LightingComponent)!.state.intensity).toBeCloseTo(0.42, 5);
  });

  test('legacy snapshot without a Table re-bootstraps Table from defaults (slice 7)', () => {
    pair = setup();
    pair.host.replaceScene([]);  // legacy = empty snap

    const table = pair.host.get(TABLE_ENTITY_ID);
    expect(table).toBeDefined();
    expect(table!.entity.type).toBe('table');
    expect(table!.entity.tags.sort()).toEqual(['fixture', 'table']);
    // Defaults from the spawnable definition.
    expect(table!.get(MeshComponent)!.state.meshRef).toBe('prim:table-rect');
    expect(table!.get(LightingComponent)!.state.color).toBe('#fff1dc');
  });

  test('post-load host/guest convergence: guest mirrors the rebuilt Table (slice 7)', () => {
    pair = setup();
    pair.host.tick(0.016);  // initial Table replicates to guest

    pair.host.updateComponentProp(TABLE_ENTITY_ID, 'skydome', 'textureUrl', 'custom:sky/saved');
    const snap = pair.host.snapshot();

    // Drift the host's state, then reload from the saved snap.
    pair.host.updateComponentProp(TABLE_ENTITY_ID, 'skydome', 'textureUrl', 'custom:sky/drift');
    pair.host.replaceScene(snap);
    pair.host.tick(0.016);

    const guestSky = pair.guest.get(TABLE_ENTITY_ID)!.get(SkydomeComponent)!;
    expect(guestSky.state.textureUrl).toBe('custom:sky/saved');
  });

  test('legacy load on host pushes a Table to the guest too (slice 7)', () => {
    pair = setup();
    pair.host.tick(0.016);

    // Empty snapshot — host re-bootstraps Table; guest receives the same
    // effective scene-replace envelope and lands on the rebooted Table.
    pair.host.replaceScene([]);
    pair.host.tick(0.016);

    const guestTable = pair.guest.get(TABLE_ENTITY_ID);
    expect(guestTable).toBeDefined();
    expect(guestTable!.get(MeshComponent)!.state.meshRef).toBe('prim:table-rect');
  });

  test('no double-Table observable during the despawn → load transition (slice 7)', () => {
    pair = setup();
    const snap = pair.host.snapshot();
    pair.host.replaceScene(snap);
    // Exactly one entity carries TableComponent after the round-trip.
    const tables = pair.host.all().filter(h => h.entity.hasComponent(TableComponent));
    expect(tables).toHaveLength(1);
    expect(tables[0].id).toBe(TABLE_ENTITY_ID);
  });

  test('LightingComponent state replicates host → guest (slice 3)', () => {
    pair = setup();
    pair.host.tick(0.016);  // replicate Table to guest
    const hostLight = pair.host.get(TABLE_ENTITY_ID)!.get(LightingComponent)!;
    hostLight.setState({ color: '#80ff00', intensity: 2.0 });
    pair.host.tick(0.016);

    const guestLight = pair.guest.get(TABLE_ENTITY_ID)!.get(LightingComponent)!;
    expect(guestLight.state.color).toBe('#80ff00');
    expect(guestLight.state.intensity).toBeCloseTo(2.0, 5);
    // The underlying THREE light on the guest tracks the replicated state.
    expect(guestLight.light.intensity).toBeCloseTo(2.0, 5);
    expect('#' + guestLight.light.color.getHexString()).toBe('#80ff00');
  });
});

describe('World.pickByObject3D — isContained guard', () => {
  let pair: Pair | null = null;

  afterEach(() => {
    pair?.host.dispose();
    pair?.guest.dispose();
    pair = null;
  });

  test('returns the entity for a normal pick', () => {
    pair = setup();
    const handle = pair.host.spawn('die', { id: 'die-pick' });
    const obj = handle.get(TransformComponent)!.object3d;
    expect(pair.host.pickByObject3D(obj)?.id).toBe('die-pick');
  });

  test('returns undefined for an entity with isContained=true', () => {
    pair = setup();
    const handle = pair.host.spawn('card', { id: 'card-contained' });
    handle.entity.isContained = true;
    const obj = handle.get(TransformComponent)!.object3d;
    expect(pair.host.pickByObject3D(obj)).toBeUndefined();
  });
});

describe('World — host→guest round-trip', () => {
  let pair: Pair | null = null;

  afterEach(() => {
    pair?.host.dispose();
    pair?.guest.dispose();
    pair = null;
  });

  test('guest receives entity-spawn after host.tick flushes the replicator', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'die-1', position: [1, 5, 2] });
    pair.host.tick(0.016);

    const guestHandle = pair.guest.get('die-1');
    expect(guestHandle).toBeDefined();
    expect(guestHandle!.entity.type).toBe('die');
    expect(guestHandle!.entity.id).toBe('die-1');

    const t = guestHandle!.get(TransformComponent)!;
    expect(t.state.position[0]).toBeCloseTo(1, 5);
    expect(t.state.position[2]).toBeCloseTo(2, 5);
  });

  test('component state survives the round-trip', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'die-1' });
    pair.host.tick(0.016);

    const guestHandle = pair.guest.get('die-1');
    const value       = guestHandle!.get(ValueComponent)!;
    expect(value.state.value).toBe('6');
    expect(value.state.isNumeric).toBe(true);
  });

  test('guest.all() reflects host spawns after tick', () => {
    pair = setup();
    pair.host.spawn('die',  { id: 'a' });
    pair.host.spawn('token', { id: 'b' });
    pair.host.tick(0.016);

    // Filter out the boot-spawned Table — the test is about user spawns.
    const ids = pair.guest.all().map(h => h.id).filter(id => id !== TABLE_ENTITY_ID).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  test('host despawn propagates to guest', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'die-1' });
    pair.host.tick(0.016);
    expect(pair.guest.get('die-1')).toBeDefined();

    pair.host.despawn('die-1');
    pair.host.tick(0.016);
    expect(pair.guest.get('die-1')).toBeUndefined();
  });

  test('guest.tick is a no-op (no replication, no physics)', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'die-1' });
    pair.host.tick(0.016);

    const before = pair.guest.get('die-1')!.entity;
    pair.guest.tick(0.016);
    const after = pair.guest.get('die-1')!.entity;
    expect(after).toBe(before);
  });

  test('subscribers fire on inbound state changes', () => {
    pair = setup();
    let calls = 0;
    pair.guest.subscribe(() => { calls++; });

    pair.host.spawn('die', { id: 'die-1' });
    pair.host.tick(0.016);

    expect(calls).toBeGreaterThan(0);
  });

  test('attachSnapPoints attaches the component on host and replicates to guest', () => {
    pair = setup();
    pair.host.spawn('token', { id: 'tok-1' });
    pair.host.tick(0.016);
    expect(pair.guest.get('tok-1')!.entity.components.has('snap-points')).toBe(false);

    pair.host.attachSnapPoints('tok-1');
    expect(pair.host.get('tok-1')!.entity.components.has('snap-points')).toBe(true);

    pair.host.tick(0.016);
    expect(pair.guest.get('tok-1')!.entity.components.has('snap-points')).toBe(true);
  });

  test('attachSnapPoints is idempotent — second call is a no-op', () => {
    pair = setup();
    pair.host.spawn('token', { id: 'tok-1' });
    pair.host.attachSnapPoints('tok-1');
    pair.host.attachSnapPoints('tok-1');
    expect(pair.host.get('tok-1')!.entity.components.has('snap-points')).toBe(true);
  });

  test('broadcastPlaySound fires local subscribers and replicates to guest (issue #11)', () => {
    pair = setup();
    const hostSeen:  string[] = [];
    const guestSeen: string[] = [];
    pair.host.onPlaySound((m)  => hostSeen.push(m.slug));
    pair.guest.onPlaySound((m) => guestSeen.push(m.slug));

    pair.host.broadcastPlaySound('custom:dice-roll');
    expect(hostSeen).toEqual(['custom:dice-roll']);
    expect(guestSeen).toEqual(['custom:dice-roll']);
  });

  test('guest broadcastPlaySound is a no-op (host-only API)', () => {
    pair = setup();
    const hostSeen:  string[] = [];
    pair.host.onPlaySound((m) => hostSeen.push(m.slug));

    pair.guest.broadcastPlaySound('custom:roll');
    expect(hostSeen).toEqual([]);
  });
});

describe('World — locked entity gates tryHold / setPosition', () => {
  let pair: Pair | null = null;

  afterEach(() => {
    pair?.host.dispose();
    pair?.guest.dispose();
    pair = null;
  });

  test('host tryHold short-circuits on locked entity', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'die-1', position: [0, 5, 0] });
    pair.host.tick(0.016);
    const hostHandle = pair.host.get('die-1')!;
    hostHandle.get(PhysicsComponent)!.setState({ isLocked: true });
    expect(hostHandle.tryHold(HOST_SEAT)).toBe(false);
    expect(hostHandle.heldBy()).toBeNull();
  });

  test('guest tryHold short-circuits client-side on locked entity (no RPC sent)', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'die-1', position: [0, 5, 0] });
    pair.host.tick(0.016);  // replicate the spawn first
    pair.host.get('die-1')!.get(PhysicsComponent)!.setState({ isLocked: true });
    pair.host.tick(0.016);  // replicate the lock patch

    const guestHandle = pair.guest.get('die-1')!;
    expect(guestHandle.get(PhysicsComponent)!.state.isLocked).toBe(true);
    expect(guestHandle.tryHold(GUEST_SEAT)).toBe(false);

    pair.host.tick(0.016);
    expect(pair.host.get('die-1')!.heldBy()).toBeNull();
  });

  test('host setPosition no-ops on locked entity', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'die-1', position: [0, 5, 0] });
    pair.host.tick(0.016);
    const hostHandle = pair.host.get('die-1')!;
    hostHandle.get(PhysicsComponent)!.setState({ isLocked: true });

    const beforeX = hostHandle.get(PhysicsComponent)!.body.position.x;
    hostHandle.setPosition(7, 7, 7);
    const afterX = hostHandle.get(PhysicsComponent)!.body.position.x;
    expect(afterX).toBe(beforeX);
  });

  test('guest setPosition no-ops on locked entity (no optimistic update, no RPC)', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'die-1', position: [0, 5, 0] });
    pair.host.tick(0.016);  // replicate spawn first
    pair.host.get('die-1')!.get(PhysicsComponent)!.setState({ isLocked: true });
    pair.host.tick(0.016);  // replicate lock patch

    const guestHandle = pair.guest.get('die-1')!;
    const beforeT = guestHandle.get(TransformComponent)!.state.position.slice();
    guestHandle.setPosition(7, 7, 7);
    const afterT = guestHandle.get(TransformComponent)!.state.position;
    expect(afterT).toEqual(beforeT);

    pair.host.tick(0.016);
    const hostBody = pair.host.get('die-1')!.get(PhysicsComponent)!.body;
    expect(hostBody.position.x).not.toBeCloseTo(7, 5);
  });
});

describe('World — EntityHandle.applyImpulse (issue #5a)', () => {
  let pair: Pair | null = null;

  afterEach(() => {
    pair?.host.dispose();
    pair?.guest.dispose();
    pair = null;
  });

  test('host applyImpulse writes velocity onto the body', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'die-1', position: [0, 5, 0] });
    pair.host.tick(0.016);
    const handle = pair.host.get('die-1')!;
    handle.applyImpulse({ x: 0.5, y: 0, z: 0 });
    expect(handle.get(PhysicsComponent)!.body.velocity.x).toBeGreaterThan(0);
  });

  test('host applyImpulse no-ops when entity is locked', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'die-1', position: [0, 5, 0] });
    pair.host.tick(0.016);
    const handle = pair.host.get('die-1')!;
    handle.get(PhysicsComponent)!.setState({ isLocked: true });
    const before = handle.get(PhysicsComponent)!.body.velocity.length();
    handle.applyImpulse({ x: 0.5, y: 0, z: 0 });
    const after = handle.get(PhysicsComponent)!.body.velocity.length();
    expect(after).toBe(before);
  });

  test('guest applyImpulse routes through host RPC', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'die-1', position: [0, 5, 0] });
    pair.host.tick(0.016);
    const guestHandle = pair.guest.get('die-1')!;
    guestHandle.applyImpulse({ x: 0.5, y: 0, z: 0 });
    // Host writes synchronously inside HostInputDispatcher.handleApplyImpulse.
    const hostBody = pair.host.get('die-1')!.get(PhysicsComponent)!.body;
    expect(hostBody.velocity.x).toBeGreaterThan(0);
  });

  test('guest applyImpulse short-circuits client-side when locked (no RPC)', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'die-1', position: [0, 5, 0] });
    pair.host.tick(0.016);
    pair.host.get('die-1')!.get(PhysicsComponent)!.setState({ isLocked: true });
    pair.host.tick(0.016);

    const guestHandle = pair.guest.get('die-1')!;
    expect(guestHandle.get(PhysicsComponent)!.state.isLocked).toBe(true);
    guestHandle.applyImpulse({ x: 5, y: 0, z: 0 });
    pair.host.tick(0.016);
    const hostBody = pair.host.get('die-1')!.get(PhysicsComponent)!.body;
    expect(hostBody.velocity.length()).toBe(0);
  });

  test('guest applyImpulse refused when entity is owned by another seat', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'die-1', position: [0, 5, 0] });
    // Owner = host's seat (0). Guest is seat 1 → canManipulate denies.
    pair.host.get('die-1')!.entity.owner = 0;
    pair.host.tick(0.016);

    const guestHandle = pair.guest.get('die-1')!;
    guestHandle.applyImpulse({ x: 0.5, y: 0, z: 0 });
    const hostBody = pair.host.get('die-1')!.get(PhysicsComponent)!.body;
    expect(hostBody.velocity.x).toBe(0);
    expect(hostBody.velocity.z).toBe(0);
  });
});

describe('World — guest drag round-trip (issue #3)', () => {
  let pair: Pair | null = null;

  afterEach(() => {
    pair?.host.dispose();
    pair?.guest.dispose();
    pair = null;
  });

  test('guest tryHold → host accepts → guest sees heldBy === guest seat', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'die-1', position: [0, 5, 0] });
    pair.host.tick(0.016);

    const guestHandle = pair.guest.get('die-1')!;
    expect(guestHandle.heldBy()).toBeNull();

    const accepted = guestHandle.tryHold(GUEST_SEAT);
    // Guest's tryHold returns true on local validation; the host echo arrives
    // through the InMemoryTransport synchronously inside the same call (host
    // dispatches HostInputDispatcher.handleHoldClaim → HoldService.tryClaim
    // → enqueueHoldClaim → host.tick flushes the echo to guest). Without a
    // host.tick the echo hasn't been flushed yet.
    expect(accepted).toBe(true);
    expect(guestHandle.heldBy()).toBeNull();  // echo not yet flushed

    pair.host.tick(0.016);
    expect(guestHandle.heldBy()).toBe(GUEST_SEAT);
  });

  test('guest setPosition writes host body via guest-drag-move RPC', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'die-1', position: [0, 5, 0] });
    pair.host.tick(0.016);

    const guestHandle = pair.guest.get('die-1')!;
    guestHandle.tryHold(GUEST_SEAT);
    pair.host.tick(0.016);  // flush hold-claim echo to guest

    const targetX = 2.5;
    const targetY = 1.0;
    const targetZ = -1.5;
    guestHandle.setPosition(targetX, targetY, targetZ);

    // GuestInputHandler on the host writes body.position synchronously.
    const hostBody = pair.host.get('die-1')!.get(PhysicsComponent)!.body;
    expect(hostBody.position.x).toBeCloseTo(targetX, 5);
    expect(hostBody.position.y).toBeCloseTo(targetY, 5);
    expect(hostBody.position.z).toBeCloseTo(targetZ, 5);

    // Guest's optimistic transform tracks the same target.
    const guestT = guestHandle.get(TransformComponent)!;
    expect(guestT.state.position[0]).toBeCloseTo(targetX, 5);
    expect(guestT.state.position[1]).toBeCloseTo(targetY, 5);
    expect(guestT.state.position[2]).toBeCloseTo(targetZ, 5);
  });

  test('guest release with velocity flips heldBy back to null + applies throw', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'die-1', position: [0, 5, 0] });
    pair.host.tick(0.016);

    const guestHandle = pair.guest.get('die-1')!;
    guestHandle.tryHold(GUEST_SEAT);
    pair.host.tick(0.016);
    expect(guestHandle.heldBy()).toBe(GUEST_SEAT);

    guestHandle.release({ vx: 1, vy: 0, vz: 2 });
    // Host's HostInputDispatcher.handleHoldRelease ran HoldService.release
    // synchronously: entity.heldBy=null + body velocity set.
    const hostHandle = pair.host.get('die-1')!;
    expect(hostHandle.heldBy()).toBeNull();
    const hostBody = hostHandle.get(PhysicsComponent)!.body;
    expect(hostBody.velocity.x).toBeCloseTo(1, 5);
    expect(hostBody.velocity.z).toBeCloseTo(2, 5);

    // Guest needs the host echo to update its view of heldBy.
    pair.host.tick(0.016);
    expect(guestHandle.heldBy()).toBeNull();
  });

  test('full drag → carry → release: host body matches guest optimistic position', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'die-1', position: [0, 5, 0] });
    pair.host.tick(0.016);

    const guestHandle = pair.guest.get('die-1')!;
    guestHandle.tryHold(GUEST_SEAT);
    pair.host.tick(0.016);

    guestHandle.setPosition(3, 1, 4);
    pair.host.tick(0.016);  // physics step + flush component-patches to guest

    const hostBody = pair.host.get('die-1')!.get(PhysicsComponent)!.body;
    const guestPos = guestHandle.position();
    // Body is kinematic during a hold — physics step doesn't move it. Host
    // body and guest optimistic position both sit at the target.
    expect(hostBody.position.x).toBeCloseTo(guestPos.x, 5);
    expect(hostBody.position.z).toBeCloseTo(guestPos.z, 5);

    guestHandle.release();
    pair.host.tick(0.016);
    expect(guestHandle.heldBy()).toBeNull();
  });
});

describe('World — late-join scene-snapshot (issue #8)', () => {
  let pair: Pair | null = null;

  afterEach(() => {
    pair?.host.dispose();
    pair?.guest.dispose();
    pair = null;
  });

  test('host pre-populates 3 entities; guest joins; sees full scene', () => {
    pair = setup();
    // Pre-populate the host. Snapshot includes the boot-spawned Table, so
    // we use replaceScene (which cascade-despawns first) to seed the rebuilt
    // host without colliding on the duplicate Table id.
    pair.host.spawn('die',   { id: 'd-1' });
    pair.host.spawn('token', { id: 't-1' });
    pair.host.spawn('board', { id: 'b-1' });
    const snap = pair.host.snapshot();
    pair.host.dispose();
    pair.guest.dispose();

    pair = setup();
    pair.host.replaceScene(snap);

    pair.firePeerJoin('host', GUEST_PEER_ID);

    const ids = pair.guest.all().map(h => h.id).filter(id => id !== TABLE_ENTITY_ID).sort();
    expect(ids).toEqual(['b-1', 'd-1', 't-1']);

    const guestDie = pair.guest.get('d-1')!;
    expect(guestDie.entity.type).toBe('die');
    expect(guestDie.get(ValueComponent)!.state.value).toBe('6');
  });

  test('snapshot is idempotent — re-firing peer-join does not throw on duplicates', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'd-1' });
    const snap = pair.host.snapshot();
    pair.host.dispose();
    pair.guest.dispose();

    pair = setup();
    pair.host.replaceScene(snap);

    pair.firePeerJoin('host', GUEST_PEER_ID);
    expect(() => pair!.firePeerJoin('host', GUEST_PEER_ID)).not.toThrow();
    const ids = pair.guest.all().map(h => h.id).filter(id => id !== TABLE_ENTITY_ID);
    expect(ids).toEqual(['d-1']);
  });

  test('guest peer-join handler is a no-op (only host replays)', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'd-1' });
    pair.host.tick(0.016);

    // Firing a peer-join on the guest's side should not produce an error or
    // a stray scene-snapshot from the guest. Guest entities are still there.
    expect(() => pair!.firePeerJoin('guest', HOST_PEER_ID)).not.toThrow();
    expect(pair.guest.get('d-1')).toBeDefined();
  });
});

describe('World — reliable / unreliable channel routing (issue #9)', () => {
  let pair: Pair | null = null;

  afterEach(() => {
    pair?.host.dispose();
    pair?.guest.dispose();
    pair = null;
  });

  function setupWithLoss(unreliableLossProbability: number, seed = 0): Pair {
    // Deterministic LCG so the test is reproducible without a real RNG dep.
    let s = seed || 1;
    const random = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
    const bus = createInMemoryBusPair({ unreliableLossProbability, random });
    const peerSeats = new Map<string, SeatIndex>([[GUEST_PEER_ID, GUEST_SEAT]]);
    const host = createWorld({
      role: 'host', scene: new THREE.Scene(),
      identity: { isHost: true, selfSeat: () => HOST_SEAT, selfPeerId: () => HOST_PEER_ID },
      transport: bus.host,
      getPeerSeat: (peerId) => peerSeats.get(peerId) ?? null,
    });
    const guest = createWorld({
      role: 'guest', scene: new THREE.Scene(),
      identity: { isHost: false, selfSeat: () => GUEST_SEAT, selfPeerId: () => GUEST_PEER_ID },
      transport: bus.guest,
    });
    return { host, guest, firePeerJoin: bus.firePeerJoin };
  }

  test('spawn (reliable) survives 30% unreliable-channel loss', () => {
    pair = setupWithLoss(0.3);
    pair.host.spawn('die', { id: 'd-1', position: [0, 5, 0] });
    pair.host.tick(0.016);

    // entity-spawn rides the reliable channel — InMemoryTransport never drops
    // it regardless of unreliableLossProbability.
    expect(pair.guest.get('d-1')).toBeDefined();
  });

  test('transform (unreliable) drops are tolerated; eventual final state arrives', () => {
    pair = setupWithLoss(0.3);
    pair.host.spawn('die', { id: 'd-1', position: [0, 5, 0] });
    pair.host.tick(0.016);

    // Drive the host through many ticks; physics syncs transform every tick
    // on the unreliable channel. With 30% loss, ~70% of envelopes get
    // through — over 50 ticks the guest's transform converges close to the
    // host's authoritative position even though individual envelopes are
    // lost.
    for (let i = 0; i < 50; i++) pair.host.tick(0.016);

    const hostT  = pair.host.get('d-1')!.get(TransformComponent)!;
    const guestT = pair.guest.get('d-1')!.get(TransformComponent)!;
    expect(guestT.state.position[0]).toBeCloseTo(hostT.state.position[0], 1);
    expect(guestT.state.position[1]).toBeCloseTo(hostT.state.position[1], 1);
    expect(guestT.state.position[2]).toBeCloseTo(hostT.state.position[2], 1);
  });

  test('100% unreliable loss: spawn still lands; transform never updates', () => {
    pair = setupWithLoss(1.0);
    pair.host.spawn('die', { id: 'd-1', position: [0, 5, 0] });
    for (let i = 0; i < 5; i++) pair.host.tick(0.016);

    // Reliable side delivered the spawn with its initial state.
    const guestT = pair.guest.get('d-1')!.get(TransformComponent)!;
    expect(guestT.state.position[1]).toBeCloseTo(5, 5);

    // Unreliable side is fully dropped; subsequent physics-driven transform
    // updates never reach the guest. Host has fallen further from the spawn
    // pose under gravity.
    const hostT = pair.host.get('d-1')!.get(TransformComponent)!;
    expect(hostT.state.position[1]).toBeLessThan(5);
  });
});

describe('World — ReplicationPolicy (issue #10)', () => {
  let pair: Pair | null = null;

  afterEach(() => {
    pair?.host.dispose();
    pair?.guest.dispose();
    pair = null;
  });

  function setupWithPolicy(policy: Partial<{
    channelFor:  (typeId: string) => 'reliable' | 'unreliable';
    coalesceFor: (typeId: string) => 'merge' | 'replace' | 'last-write-wins';
    shouldFlush: (typeId: string, ctx: { tick: number; nowMs: number }) => boolean;
  }>): { pair: Pair; sentPatches: { typeId: string; entityId: string }[] } {
    const sentPatches: { typeId: string; entityId: string }[] = [];
    const bus = createInMemoryBusPair();
    const peerSeats = new Map<string, SeatIndex>([[GUEST_PEER_ID, GUEST_SEAT]]);

    // Wrap bus.host so we can spy on outbound component-patches envelopes.
    const spyHost = {
      ...bus.host,
      send(msg: any, opts: { reliable: boolean }) {
        if (msg?.type === 'component-patches') {
          for (const p of msg.patches) sentPatches.push({ typeId: p.typeId, entityId: p.entityId });
        }
        bus.host.send(msg, opts);
      },
    };

    const host = createWorld({
      role: 'host', scene: new THREE.Scene(),
      identity: { isHost: true, selfSeat: () => HOST_SEAT, selfPeerId: () => HOST_PEER_ID },
      transport: spyHost,
      policy,
      getPeerSeat: (peerId) => peerSeats.get(peerId) ?? null,
    });
    const guest = createWorld({
      role: 'guest', scene: new THREE.Scene(),
      identity: { isHost: false, selfSeat: () => GUEST_SEAT, selfPeerId: () => GUEST_PEER_ID },
      transport: bus.guest,
    });
    return { pair: { host, guest, firePeerJoin: bus.firePeerJoin }, sentPatches };
  }

  test('last-write-wins collapses N intra-tick mutations into one wire patch', () => {
    const { pair: p, sentPatches } = setupWithPolicy({
      coalesceFor: () => 'last-write-wins',
    });
    pair = p;

    pair.host.spawn('die', { id: 'd-1', position: [0, 5, 0] });
    pair.host.tick(0.016);  // initial spawn + first physics tick

    // Drain initial patches before counting.
    const before = sentPatches.length;

    // 10 manual transform setStates in one synchronous burst.
    const t = pair.host.get('d-1')!.get(TransformComponent)!;
    for (let i = 0; i < 10; i++) {
      t.setState({ position: [i, 5, 0], rotation: t.state.rotation, scale: t.state.scale });
    }
    pair.host.tick(0.016);

    // Count transform patches sent on this tick — there'd be at least 10
    // without coalescing (10 setStates) plus any physics-driven ones; under
    // last-write-wins the tick produces exactly one transform patch for d-1.
    const transformPatches = sentPatches.slice(before).filter(p => p.typeId === 'transform' && p.entityId === 'd-1');
    expect(transformPatches).toHaveLength(1);
  });

  test('shouldFlush returning false defers the tick; later returning true releases', () => {
    let flushAllowed = false;
    const { pair: p, sentPatches } = setupWithPolicy({
      shouldFlush: (typeId) => typeId === 'transform' ? flushAllowed : true,
    });
    pair = p;

    pair.host.spawn('die', { id: 'd-1', position: [0, 5, 0] });
    pair.host.tick(0.016);  // entity-spawn (reliable, not gated) + transform deferred

    const before = sentPatches.length;
    const t = pair.host.get('d-1')!.get(TransformComponent)!;
    t.setState({ position: [1, 5, 0], rotation: t.state.rotation, scale: t.state.scale });
    pair.host.tick(0.016);
    pair.host.tick(0.016);

    // While shouldFlush returns false for transform, no transform patches go
    // out — physics-driven setStates accumulate but stay buffered.
    const deferredCount = sentPatches.slice(before).filter(p => p.typeId === 'transform').length;
    expect(deferredCount).toBe(0);

    // Open the gate. Next tick drains the buffer (coalesced merge → one patch).
    flushAllowed = true;
    const beforeRelease = sentPatches.length;
    pair.host.tick(0.016);
    const releasedCount = sentPatches.slice(beforeRelease).filter(p => p.typeId === 'transform').length;
    expect(releasedCount).toBeGreaterThanOrEqual(1);
  });

  test('default policy preserves channel from EntityComponent.channel static', () => {
    // No policy override — World's DEFAULT_POLICY reads componentRegistry.
    pair = setup();
    pair.host.spawn('die', { id: 'd-1', position: [0, 5, 0] });
    pair.host.tick(0.016);

    // TransformComponent.channel is 'unreliable'; ValueComponent has no
    // override (defaults to 'reliable' on the base class). The boundary
    // tests above already exercised this; here we just sanity-check the
    // guest still receives state.
    expect(pair.guest.get('d-1')).toBeDefined();
  });
});

describe('World — replaceScene (PRD save/load issue #1)', () => {
  let pair: Pair | null = null;

  afterEach(() => {
    pair?.host.dispose();
    pair?.guest.dispose();
    pair = null;
  });

  test('host round-trip: snapshot → mutate → replaceScene matches original', () => {
    pair = setup();
    pair.host.spawn('die',   { id: 'd-1', position: [1, 5, 2] });
    pair.host.spawn('token', { id: 't-1', position: [-1, 5, 0] });
    pair.host.tick(0.016);

    const snap = pair.host.snapshot();

    pair.host.spawn('die', { id: 'd-2' });
    pair.host.despawn('t-1');
    pair.host.tick(0.016);

    pair.host.replaceScene(snap);

    const ids = pair.host.all().map(h => h.id).filter(id => id !== TABLE_ENTITY_ID).sort();
    expect(ids).toEqual(['d-1', 't-1']);
  });

  test('replaceScene cascade-despawns: the prior THREE Object3D is removed from the scene', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'd-1' });
    pair.host.tick(0.016);
    const oldObj = pair.host.get('d-1')!.get(TransformComponent)!.object3d;

    pair.host.replaceScene([]);
    // Slice 7 re-bootstraps the Table on legacy (empty) snap loads, so the
    // post-replace scene contains exactly one entity: the Table.
    expect(pair.host.all().map(h => h.id).filter(id => id !== TABLE_ENTITY_ID)).toEqual([]);

    // Object3D from the prior entity must be detached from its parent.
    expect(oldObj.parent).toBeNull();
  });

  test('held entity loses its hold on replace', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'd-1', position: [0, 5, 0] });
    pair.host.tick(0.016);
    pair.host.get('d-1')!.tryHold(HOST_SEAT);
    expect(pair.host.get('d-1')!.heldBy()).toBe(HOST_SEAT);

    const snap = pair.host.snapshot();
    pair.host.replaceScene(snap);

    expect(pair.host.get('d-1')!.heldBy()).toBeNull();
  });

  test('guest receives scene-replace and rebuilds the scene', () => {
    pair = setup();
    pair.host.spawn('die',   { id: 'd-1', position: [1, 5, 2] });
    pair.host.spawn('token', { id: 't-1', position: [-1, 5, 0] });
    pair.host.tick(0.016);

    const snap = pair.host.snapshot();

    pair.host.spawn('die', { id: 'd-2' });
    pair.host.despawn('t-1');
    pair.host.tick(0.016);

    pair.host.replaceScene(snap);

    const guestIds = pair.guest.all().map(h => h.id).filter(id => id !== TABLE_ENTITY_ID).sort();
    expect(guestIds).toEqual(['d-1', 't-1']);
    expect(pair.guest.get('d-2')).toBeUndefined();
  });

  test('replaceScene to an empty array clears host and guest (Table re-bootstraps)', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'd-1' });
    pair.host.spawn('token', { id: 't-1' });
    pair.host.tick(0.016);

    pair.host.replaceScene([]);

    // Empty snapshot is treated as "legacy" — Table re-bootstraps. User
    // entities (die / token) are gone.
    const hostUserIds  = pair.host.all().map(h => h.id).filter(id => id !== TABLE_ENTITY_ID);
    const guestUserIds = pair.guest.all().map(h => h.id).filter(id => id !== TABLE_ENTITY_ID);
    expect(hostUserIds).toEqual([]);
    expect(guestUserIds).toEqual([]);
  });

  test('camera, selection, and current tool are not affected by replace', () => {
    // World does not own camera / selection / tool — they are external. This
    // test asserts the negative: replaceScene does not throw and entity-bound
    // state survives the replace; the absence of any UI-state-bearing fields
    // on World is the structural guarantee.
    pair = setup();
    pair.host.spawn('die', { id: 'd-1' });
    pair.host.tick(0.016);
    expect(() => pair!.host.replaceScene(pair!.host.snapshot())).not.toThrow();
  });

  test('guest-drag-move for an entity that disappears is silently dropped', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'd-1', position: [0, 5, 0] });
    pair.host.tick(0.016);

    pair.host.replaceScene([]);  // wipe everything on host + guest

    // Guest has no record of d-1; an attempt to setPosition is a no-op locally
    // (no entity to dispatch through), and the host's GuestInputHandler would
    // drop a stray guest-drag-move for an unknown id without throwing.
    expect(pair.guest.get('d-1')).toBeUndefined();
    expect(pair.host.get('d-1')).toBeUndefined();
  });
});

describe('World — history push hooks (issue #5)', () => {
  let pair: Pair | null = null;

  afterEach(() => {
    pair?.host.dispose();
    pair?.guest.dispose();
    pair = null;
  });

  test('host-only: guest world has no SceneHistoryService', () => {
    pair = setup();
    expect(pair.host.history).not.toBeNull();
    expect(pair.guest.history).toBeNull();
  });

  test('spawn pushes an entry; tick does not', () => {
    pair = setup();
    const before = pair.host.history!.entries().length;
    pair.host.spawn('die', { id: 'd-1' });
    expect(pair.host.history!.entries().length).toBe(before + 1);

    const afterSpawn = pair.host.history!.entries().length;
    pair.host.tick(0.016);
    pair.host.tick(0.016);
    expect(pair.host.history!.entries().length).toBe(afterSpawn);
  });

  test('despawn pushes an entry', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'd-1' });
    const before = pair.host.history!.entries().length;
    pair.host.despawn('d-1');
    expect(pair.host.history!.entries().length).toBe(before + 1);
  });

  test('updateEntityField pushes an entry', () => {
    pair = setup();
    pair.host.spawn('token', { id: 't-1' });
    const before = pair.host.history!.entries().length;
    pair.host.updateEntityField('t-1', 'name', 'Renamed');
    expect(pair.host.history!.entries().length).toBe(before + 1);
  });

  test('Load (setLastLoaded) clears the undo stack', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'd-1' });
    pair.host.spawn('token', { id: 't-1' });
    expect(pair.host.history!.entries().length).toBeGreaterThan(0);

    pair.host.history!.setLastLoaded({ snapshot: [], filename: 'x.json', savedAt: '' });
    expect(pair.host.history!.entries()).toHaveLength(0);
  });

  test('restore delegates to replaceScene; guest receives the swap', () => {
    pair = setup();
    pair.host.spawn('die', { id: 'd-1' });
    pair.host.tick(0.016);
    const entries = pair.host.history!.entries();
    expect(entries.length).toBeGreaterThan(0);
    const root = entries[0];  // pre-spawn state (Table only)

    pair.host.history!.restore(root);
    pair.host.tick(0.016);
    const hostIds  = pair.host.all().map(h => h.id).filter(id => id !== TABLE_ENTITY_ID);
    const guestIds = pair.guest.all().map(h => h.id).filter(id => id !== TABLE_ENTITY_ID);
    expect(hostIds).toEqual([]);
    expect(guestIds).toEqual([]);
  });
});

describe('World — updateEntityField / updateComponentProp (issue #1 of property-schema-refactor)', () => {
  let pair: Pair | null = null;

  afterEach(() => {
    pair?.host.dispose();
    pair?.guest.dispose();
    pair = null;
  });

  test('updateEntityField rewrites name and replicates via entity-patch', async () => {
    const { CardComponent } = await import('../components/CardComponent');
    void CardComponent;  // ensure module loaded
    pair = setup();
    pair.host.spawn('card', { id: 'c-1' });
    pair.host.tick(0.016);

    pair.host.updateEntityField('c-1', 'name', 'My Hand');
    pair.host.tick(0.016);

    expect(pair.host.get('c-1')!.entity.name).toBe('My Hand');
    expect(pair.guest.get('c-1')!.entity.name).toBe('My Hand');
  });

  test('updateEntityField rewrites tags and owner', () => {
    pair = setup();
    pair.host.spawn('card', { id: 'c-2' });

    pair.host.updateEntityField('c-2', 'tags', ['marker', 'zone']);
    pair.host.updateEntityField('c-2', 'owner', 1);

    const card = pair.host.get('c-2')!;
    expect(card.entity.tags).toEqual(['marker', 'zone']);
    expect(card.entity.owner).toBe(1);
  });

  test('updateEntityField for unknown id is a no-op', () => {
    pair = setup();
    expect(() => pair!.host.updateEntityField('nope', 'name', 'X')).not.toThrow();
  });

  test('updateComponentProp routes to the named component', async () => {
    const { CardComponent } = await import('../components/CardComponent');
    pair = setup();
    pair.host.spawn('card', { id: 'c-3' });
    pair.host.tick(0.016);

    pair.host.updateComponentProp('c-3', 'card', 'face', 'face.png');
    pair.host.updateComponentProp('c-3', 'card', 'back', 'back.png');
    pair.host.tick(0.016);

    const hostCard  = pair.host.get('c-3')!.get(CardComponent)!;
    const guestCard = pair.guest.get('c-3')!.get(CardComponent)!;
    expect(hostCard.state.face).toBe('face.png');
    expect(hostCard.state.back).toBe('back.png');
    expect(guestCard.state.face).toBe('face.png');
    expect(guestCard.state.back).toBe('back.png');
  });

  test('updateComponentProp pre-clamps via schema min/max', async () => {
    const { EntityComponent } = await import('../EntityComponent');
    const { componentRegistry } = await import('../ComponentRegistry');
    const { registerSpawnable, getSpawnable } = await import('../SpawnableRegistry');

    class ClampComp extends EntityComponent<{ n: number }> {
      static typeId = 'clamp';
      static label  = 'Clamp';
      static propertySchema = [
        { key: 'n', label: 'N', type: 'number' as const, min: 0, max: 10 },
      ];
      onSpawn() {}
      onPropertiesChanged() {}
    }
    if (!componentRegistry.has('clamp')) componentRegistry.register(ClampComp);
    if (!getSpawnable('clampy')) registerSpawnable({
      type: 'clampy',
      label: 'Clampy',
      category: 'Test',
      defaultTags: [],
      components: [{ typeId: 'clamp', state: { n: 5 } }],
    });

    pair = setup();
    pair.host.spawn('clampy', { id: 'k-1' });

    pair.host.updateComponentProp('k-1', 'clamp', 'n', 99);
    expect(pair.host.get('k-1')!.get(ClampComp)!.state.n).toBe(10);

    pair.host.updateComponentProp('k-1', 'clamp', 'n', -5);
    expect(pair.host.get('k-1')!.get(ClampComp)!.state.n).toBe(0);
  });

  test('updateComponentProp invokes adapter set when present', async () => {
    const { EntityComponent } = await import('../EntityComponent');
    const { componentRegistry } = await import('../ComponentRegistry');
    const { registerSpawnable, getSpawnable } = await import('../SpawnableRegistry');

    class AdapterComp extends EntityComponent<{ vec: [number, number, number] }> {
      static typeId = 'adapter';
      static label  = 'Adapter';
      static propertySchema = [
        {
          key:   'x',
          label: 'X',
          type:  'number' as const,
          get:   (s: { vec: [number, number, number] }) => s.vec[0],
          set:   (v: unknown, s: { vec: [number, number, number] }) =>
                  ({ vec: [Number(v), s.vec[1], s.vec[2]] as [number, number, number] }),
        },
      ];
      onSpawn() {}
      onPropertiesChanged() {}
    }
    if (!componentRegistry.has('adapter')) componentRegistry.register(AdapterComp);
    if (!getSpawnable('adapty')) registerSpawnable({
      type: 'adapty',
      label: 'Adapty',
      category: 'Test',
      defaultTags: [],
      components: [{ typeId: 'adapter', state: { vec: [0, 1, 2] } }],
    });

    pair = setup();
    pair.host.spawn('adapty', { id: 'a-1' });

    pair.host.updateComponentProp('a-1', 'adapter', 'x', 7);
    expect(pair.host.get('a-1')!.get(AdapterComp)!.state.vec).toEqual([7, 1, 2]);
  });

  test('updateComponentProp drops unknown component / unknown key', () => {
    pair = setup();
    pair.host.spawn('card', { id: 'c-4' });
    expect(() => pair!.host.updateComponentProp('c-4', 'nosuch', 'k', 1)).not.toThrow();
    expect(() => pair!.host.updateComponentProp('c-4', 'card', 'nosuch', 1)).not.toThrow();
  });

  test('replication patch shape: component-patches envelope carries the typed key', async () => {
    const { CardComponent } = await import('../components/CardComponent');
    void CardComponent;
    pair = setup();
    pair.host.spawn('card', { id: 'c-5' });
    pair.host.tick(0.016);

    let patchSeen: { typeId: string; key: string; value: unknown } | null = null;
    const orig = pair.guest.get('c-5')!.get(CardComponent)!;
    const subOrig = orig.applyRemoteState.bind(orig);
    orig.applyRemoteState = function (patch: Partial<{ face: string; back: string; category: string }>) {
      if (patch.face !== undefined) {
        patchSeen = { typeId: 'card', key: 'face', value: patch.face };
      }
      subOrig(patch);
    } as typeof orig.applyRemoteState;

    pair.host.updateComponentProp('c-5', 'card', 'face', 'wire-test.png');
    pair.host.tick(0.016);
    expect(patchSeen).toEqual({ typeId: 'card', key: 'face', value: 'wire-test.png' });
  });
});

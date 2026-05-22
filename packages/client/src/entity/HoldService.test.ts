import { describe, test, expect, beforeEach } from 'vitest';
import * as CANNON from 'cannon-es';
import { SceneImpl } from './Scene';
import { Entity } from './Entity';
import { HostReplicatorV2, type ReplicatorPolicy } from './HostReplicatorV2';
import { HoldService } from './HoldService';
import { PhysicsComponent } from './components/PhysicsComponent';
import { ComponentRegistry } from './ComponentRegistry';

const POLICY: ReplicatorPolicy = {
  channelFor:  () => 'reliable',
  coalesceFor: () => 'merge',
  shouldFlush: () => true,
};

// Lightweight stand-in for PhysicsComponent — exposes a real CANNON.Body so
// the kinematic toggle is observable, but skips the world-attach lifecycle
// of the real component.
class StubPhysics {
  static typeId = 'physics';
  static requires = [] as const;
  static channel = 'reliable' as const;
  body: CANNON.Body;
  state = { mass: 1, friction: 0.5, restitution: 0.3 };
  entity!: Entity;

  constructor() {
    this.body = new CANNON.Body({ mass: 1, shape: new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)) });
    this.body.type = CANNON.Body.DYNAMIC;
  }

  onSpawn() {}
  onDespawn() {}
  onPropertiesChanged() {}
  onContextMenu() { return []; }
  onCollision() {}
  onParentChanged() {}
  onOwnerChanged() {}
  onAction() {}
  setState() {}
  applyRemoteState() {}
  toJSON() { return { ...this.state }; }
  fromJSON(o: object) { this.state = { ...(o as typeof this.state) }; }
}

let scene: SceneImpl;
let r: HostReplicatorV2;
let svc: HoldService;

function spawnPhysical(id: string): { entity: Entity; phys: StubPhysics } {
  const entity = new Entity({ id, type: 'die', name: id });
  const phys = new StubPhysics();
  // Attach as the actual PhysicsComponent typeId so getComponent(PhysicsComponent) finds it.
  entity.components.set('physics', phys as unknown as PhysicsComponent);
  phys.entity = entity;
  scene.add(entity);
  return { entity, phys };
}

beforeEach(() => {
  scene = new SceneImpl();
  // Empty registry — HoldService doesn't load via the registry, just iterates entities.
  scene.setRegistry(new ComponentRegistry());
  r = new HostReplicatorV2(POLICY);
  svc = new HoldService(r, scene);
});

describe('HoldService.tryClaim', () => {
  test('accepts a claim on an unheld entity, sets heldBy + broadcasts hold-claim', () => {
    const { entity } = spawnPhysical('a');
    expect(svc.tryClaim(entity, 2)).toBe(true);
    expect(entity.heldBy).toBe(2);

    const out = r.flushReliable();
    expect(out).toEqual([
      { type: 'hold-claim', entityId: 'a', seat: 2 },
    ]);
  });

  test('refuses when already held; does not broadcast a second claim', () => {
    const { entity } = spawnPhysical('a');
    svc.tryClaim(entity, 2);
    r.flushReliable(); // drain the first claim

    expect(svc.tryClaim(entity, 5)).toBe(false);
    expect(entity.heldBy).toBe(2);
    expect(r.flushReliable()).toEqual([]);
  });

  test('toggles physics body to KINEMATIC and zeroes velocity', () => {
    const { entity, phys } = spawnPhysical('a');
    phys.body.velocity.set(3, 0, 0);
    phys.body.angularVelocity.set(0, 1, 0);
    svc.tryClaim(entity, 0);
    expect(phys.body.type).toBe(CANNON.Body.KINEMATIC);
    expect(phys.body.velocity.length()).toBe(0);
    expect(phys.body.angularVelocity.length()).toBe(0);
  });

  test('sets sensor flag (collisionResponse=false) on claim', () => {
    const { entity, phys } = spawnPhysical('a');
    expect(phys.body.collisionResponse).toBe(true);
    svc.tryClaim(entity, 0);
    expect(phys.body.collisionResponse).toBe(false);
  });
});

describe('HoldService.release', () => {
  test('clears heldBy, restores DYNAMIC body type, applies velocity, broadcasts hold-release', () => {
    const { entity, phys } = spawnPhysical('a');
    svc.tryClaim(entity, 4);
    r.flushReliable();

    svc.release(entity, { vx: 1, vy: 2, vz: 3 });
    expect(entity.heldBy).toBeNull();
    expect(phys.body.type).toBe(CANNON.Body.DYNAMIC);
    expect(phys.body.velocity.x).toBe(1);
    expect(phys.body.velocity.y).toBe(2);
    expect(phys.body.velocity.z).toBe(3);

    const out = r.flushReliable();
    expect(out).toEqual([
      { type: 'hold-release', entityId: 'a', vx: 1, vy: 2, vz: 3 },
    ]);
  });

  test('release with no velocity zeroes the body and emits a bare hold-release', () => {
    const { entity, phys } = spawnPhysical('a');
    svc.tryClaim(entity, 4);
    r.flushReliable();

    svc.release(entity);
    expect(phys.body.velocity.length()).toBe(0);
    expect(r.flushReliable()).toEqual([
      { type: 'hold-release', entityId: 'a' },
    ]);
  });

  test('releasing an unheld entity is a no-op', () => {
    const { entity } = spawnPhysical('a');
    svc.release(entity);
    expect(entity.heldBy).toBeNull();
    expect(r.flushReliable()).toEqual([]);
  });

  test('restores prior collisionResponse on release', () => {
    const { entity, phys } = spawnPhysical('a');
    svc.tryClaim(entity, 0);
    expect(phys.body.collisionResponse).toBe(false);
    svc.release(entity);
    expect(phys.body.collisionResponse).toBe(true);
  });

  test('restores prior collisionResponse even when it was false before claim', () => {
    const { entity, phys } = spawnPhysical('a');
    phys.body.collisionResponse = false;
    svc.tryClaim(entity, 0);
    svc.release(entity);
    expect(phys.body.collisionResponse).toBe(false);
  });
});

describe('HoldService.releaseAllForSeat', () => {
  test('clears every entity held by the leaving seat and broadcasts each release', () => {
    const { entity: a } = spawnPhysical('a');
    const { entity: b } = spawnPhysical('b');
    const { entity: c } = spawnPhysical('c');
    svc.tryClaim(a, 1);
    svc.tryClaim(b, 1);
    svc.tryClaim(c, 2);
    r.flushReliable();

    svc.releaseAllForSeat(1);
    expect(a.heldBy).toBeNull();
    expect(b.heldBy).toBeNull();
    expect(c.heldBy).toBe(2);

    const out = r.flushReliable();
    expect(out.map(m => m.type)).toEqual(['hold-release', 'hold-release']);
  });
});

describe('HoldService.suppressZoneEvents', () => {
  test('returns true while held, false once released — placeholder for PRD-2 zones', () => {
    const { entity } = spawnPhysical('a');
    expect(HoldService.suppressZoneEvents(entity)).toBe(false);
    svc.tryClaim(entity, 0);
    expect(HoldService.suppressZoneEvents(entity)).toBe(true);
    svc.release(entity);
    expect(HoldService.suppressZoneEvents(entity)).toBe(false);
  });
});

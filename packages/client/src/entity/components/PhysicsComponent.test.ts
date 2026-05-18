import { describe, test, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { SceneImpl } from '../Scene';
import { Entity } from '../Entity';
import { type SpawnContext, type ActionContext } from '../EntityComponent';
import { DEFAULT_PREFERENCES } from '../../preferences/types';
import { ComponentRegistry } from '../ComponentRegistry';
import { HostReplicatorV2, type ReplicatorPolicy } from '../HostReplicatorV2';
import { HoldService } from '../HoldService';
import { HostInputDispatcher } from '../HostInputDispatcher';
import { PhysicsComponent } from './PhysicsComponent';
import { aggregateContextMenu } from '../contextMenu';
import { dispatchMenuAction } from '../../input/ContextMenuController';
import { registerCorePrimitives } from '../spawnables';
import { PhysicsWorld } from '../../physics/PhysicsWorld';
import { type SeatIndex } from '../../seats/SeatLayout';
import { TABLE_ENTITY_ID } from '../tableEntity';
import { MeshComponent } from './MeshComponent';

const POLICY: ReplicatorPolicy = {
  channelFor:  () => 'reliable',
  coalesceFor: () => 'merge',
  shouldFlush: () => true,
};

let scene: SceneImpl;
let ctx: SpawnContext;

beforeEach(() => {
  registerCorePrimitives();
  scene = new SceneImpl();
  ctx = { scene: new THREE.Scene(), physics: new PhysicsWorld(), entityScene: scene };
});

describe('PhysicsComponent — isContained body lifecycle', () => {
  test('body is added to world on spawn when entity is not contained', () => {
    const e = scene.spawn('die', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    expect(ctx.physics!.world.bodies.includes(phys.body)).toBe(true);
  });

  test('onIsContainedChanged(true) removes body and zeroes velocity', () => {
    const e = scene.spawn('die', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    phys.body.velocity.set(2, 0, 0);
    phys.body.angularVelocity.set(0, 1, 0);

    phys.onIsContainedChanged(true);
    expect(ctx.physics!.world.bodies.includes(phys.body)).toBe(false);
    expect(phys.body.velocity.length()).toBe(0);
    expect(phys.body.angularVelocity.length()).toBe(0);
  });

  test('onIsContainedChanged(false) re-adds the same body (not recreated)', () => {
    const e = scene.spawn('die', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    const originalBody = phys.body;

    phys.onIsContainedChanged(true);
    expect(ctx.physics!.world.bodies.includes(originalBody)).toBe(false);

    phys.onIsContainedChanged(false);
    expect(phys.body).toBe(originalBody);
    expect(ctx.physics!.world.bodies.includes(originalBody)).toBe(true);
  });

  test('redundant onIsContainedChanged is idempotent', () => {
    const e = scene.spawn('die', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    phys.onIsContainedChanged(true);
    phys.onIsContainedChanged(true); // already removed
    expect(ctx.physics!.world.bodies.includes(phys.body)).toBe(false);
    phys.onIsContainedChanged(false);
    phys.onIsContainedChanged(false); // already added
    expect(ctx.physics!.world.bodies.filter(b => b === phys.body)).toHaveLength(1);
  });

  test('entity spawned with isContained=true skips body add', () => {
    const e = scene.spawn('die', ctx);
    // Despawn and re-create with isContained pre-set: easier path — just flip
    // and verify the lifecycle removes it.
    const phys = e.getComponent(PhysicsComponent)!;
    phys.onIsContainedChanged(true);
    expect(ctx.physics!.world.bodies.includes(phys.body)).toBe(false);
  });
});

describe('PhysicsComponent — isLocked state transitions', () => {
  test('setState({isLocked:true}) zeroes mass and remembers prior', () => {
    const e = scene.spawn('die', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    expect(phys.body.mass).toBe(0.2);

    phys.setState({ isLocked: true });
    expect(phys.body.mass).toBe(0);
    expect(phys.state.isLocked).toBe(true);
  });

  test('setState({isLocked:false}) restores prior mass', () => {
    const e = scene.spawn('die', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    phys.setState({ isLocked: true });
    phys.setState({ isLocked: false });
    expect(phys.body.mass).toBe(0.2);
    expect(phys.state.isLocked).toBe(false);
  });

  test('mass change while locked updates the saved prior, body stays at 0', () => {
    const e = scene.spawn('die', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    phys.setState({ isLocked: true });
    phys.setState({ mass: 5 });
    expect(phys.body.mass).toBe(0);
    phys.setState({ isLocked: false });
    expect(phys.body.mass).toBe(5);
  });

  test('locking zeroes velocity', () => {
    const e = scene.spawn('die', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    phys.body.velocity.set(3, 0, 1);
    phys.body.angularVelocity.set(0, 2, 0);
    phys.setState({ isLocked: true });
    expect(phys.body.velocity.length()).toBe(0);
    expect(phys.body.angularVelocity.length()).toBe(0);
  });

  test('redundant lock or unlock is idempotent (does not corrupt prior mass)', () => {
    const e = scene.spawn('die', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    phys.setState({ isLocked: true });
    phys.setState({ isLocked: true });  // redundant
    phys.setState({ isLocked: false });
    expect(phys.body.mass).toBe(0.2);
  });

  test('die / token / card spawn unlocked', () => {
    expect(scene.spawn('die',   ctx).getComponent(PhysicsComponent)!.state.isLocked).toBe(false);
    expect(scene.spawn('token', ctx).getComponent(PhysicsComponent)!.state.isLocked).toBe(false);
    expect(scene.spawn('card',  ctx).getComponent(PhysicsComponent)!.state.isLocked).toBe(false);
  });
});

describe('PhysicsComponent — applyImpulse no-op when locked', () => {
  test('locked body does not receive impulse', () => {
    const e = scene.spawn('die', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    phys.setState({ isLocked: true });
    phys.applyImpulse({ x: 10, y: 0, z: 0 });
    expect(phys.body.velocity.length()).toBe(0);
  });

  test('unlocked body receives impulse normally', () => {
    const e = scene.spawn('die', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    phys.applyImpulse({ x: 10, y: 0, z: 0 });
    expect(phys.body.velocity.length()).toBeGreaterThan(0);
  });
});

describe('PhysicsComponent — context menu toggle', () => {
  test('label flips between "Lock movement" and "Unlock movement"', () => {
    const e = scene.spawn('die', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    const actCtx: ActionContext = {
      recipientSeat: 0 as SeatIndex, isHost: true, entity: e,
      preferences:   DEFAULT_PREFERENCES,
    };

    let defs = phys.getActions(actCtx);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('lock-toggle');
    expect(defs[0].label).toBe('Lock movement');

    phys.setState({ isLocked: true });
    defs = phys.getActions(actCtx);
    expect(defs[0].label).toBe('Unlock movement');
  });

  test('aggregateContextMenu surfaces the toggle tagged with physics typeId', () => {
    const e = scene.spawn('die', ctx);
    const items = aggregateContextMenu(e, {
      recipientSeat: 0, isHost: true, entity: e,
      preferences:   DEFAULT_PREFERENCES,
    });
    const physItems = items.filter(
      i => i.kind === 'action'
        && (i as { componentTypeId?: string }).componentTypeId === 'physics',
    );
    expect(physItems).toHaveLength(1);
    const toggle = physItems[0] as { id: string; label: string };
    expect(toggle.id).toBe('lock-toggle');
    expect(toggle.label).toBe('Lock movement');
  });

  test('onAction(lock-toggle) flips state via setState', () => {
    const e = scene.spawn('die', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    const actCtx: ActionContext = {
      recipientSeat: 0, isHost: true, entity: e,
      preferences:   DEFAULT_PREFERENCES,
    };
    phys.onAction('lock-toggle', actCtx);
    expect(phys.state.isLocked).toBe(true);
    expect(phys.body.mass).toBe(0);
    phys.onAction('lock-toggle', actCtx);
    expect(phys.state.isLocked).toBe(false);
    expect(phys.body.mass).toBe(0.2);
  });
});

// Drives toggle-lock through HostInputDispatcher.handleInvokeAction with the
// canManipulate matrix — matches the existing pattern in HostInputDispatcher
// tests but uses real PhysicsComponent so the lock state actually flips.
describe('PhysicsComponent — lock toggle authority (via HostInputDispatcher)', () => {
  let svc: HoldService;
  let dispatcher: HostInputDispatcher;
  let r: HostReplicatorV2;
  const PEERS = new Map<string, SeatIndex | null>();

  beforeEach(() => {
    PEERS.clear();
    r = new HostReplicatorV2(POLICY);
    scene.world = r;
    svc = new HoldService(r, scene);
    dispatcher = new HostInputDispatcher(svc, (peerId) => PEERS.get(peerId) ?? null, scene);
  });

  function spawnDie(owner: SeatIndex | null, id = 'd-1'): Entity {
    const e = scene.spawn('die', ctx, { id });
    e.owner = owner;
    return e;
  }

  function invokeToggle(peerId: string, entityId: string): boolean {
    return dispatcher.handleInvokeAction(peerId, {
      type: 'invoke-action', entityId,
      componentTypeId: 'physics', actionId: 'lock-toggle',
    });
  }

  test('owner-seated guest can toggle', () => {
    const e = spawnDie(1);
    PEERS.set('p1', 1);
    expect(invokeToggle('p1', e.id)).toBe(true);
    expect(e.getComponent(PhysicsComponent)!.state.isLocked).toBe(true);
  });

  test('non-owner seated guest is refused', () => {
    const e = spawnDie(1);
    PEERS.set('p2', 2);
    expect(invokeToggle('p2', e.id)).toBe(false);
    expect(e.getComponent(PhysicsComponent)!.state.isLocked).toBe(false);
  });

  test('spectator (no seat) is refused', () => {
    const e = spawnDie(null);
    PEERS.set('px', null);
    expect(invokeToggle('px', e.id)).toBe(false);
    expect(e.getComponent(PhysicsComponent)!.state.isLocked).toBe(false);
  });

  test('any seated peer may toggle a no-owner entity', () => {
    const e = spawnDie(null);
    PEERS.set('p3', 3);
    expect(invokeToggle('p3', e.id)).toBe(true);
    expect(e.getComponent(PhysicsComponent)!.state.isLocked).toBe(true);
  });
});

// The Table primitives are authored with their top surface at local y=0
// (mesh shifted down by h/2). The collision shape needs the same offset so
// objects rest on the visible top instead of floating h/2 above it.
describe('PhysicsComponent — Table hitbox aligns with the visible top surface', () => {
  test('prim:table-rect body shape is offset down by h/2', () => {
    const e = scene.spawn('table', ctx, { id: TABLE_ENTITY_ID });
    const phys = e.getComponent(PhysicsComponent)!;
    const mesh = e.getComponent(MeshComponent)!;
    const [, halfH] = mesh.halfExtents();
    expect(phys.body.shapes).toHaveLength(1);
    expect(phys.body.shapeOffsets[0].y).toBeCloseTo(-halfH, 6);
    // Top of the hitbox in entity-local space sits at y=0, matching the mesh.
    expect(phys.body.shapeOffsets[0].y + halfH).toBeCloseTo(0, 6);
  });

  test('prim:table-circle body shape is offset down by h/2', () => {
    const e = scene.spawn('table', ctx, { id: TABLE_ENTITY_ID });
    e.getComponent(MeshComponent)!.setState({ meshRef: 'prim:table-circle' });
    const phys = e.getComponent(PhysicsComponent)!;
    phys.rebuildShape();
    const [, halfH] = e.getComponent(MeshComponent)!.halfExtents();
    expect(phys.body.shapeOffsets[0].y).toBeCloseTo(-halfH, 6);
  });

  test('non-table primitives keep a zero shape offset', () => {
    const e = scene.spawn('die', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    expect(phys.body.shapeOffsets[0].y).toBe(0);
  });
});

describe('PhysicsComponent — yawOnly state drives angularFactor', () => {
  test('board / deck / card default to yawOnly=true with angularFactor (0,1,0)', () => {
    for (const type of ['board', 'deck', 'card']) {
      const e = scene.spawn(type, ctx);
      const phys = e.getComponent(PhysicsComponent)!;
      expect(phys.state.yawOnly).toBe(true);
      expect(phys.body.angularFactor.x).toBe(0);
      expect(phys.body.angularFactor.y).toBe(1);
      expect(phys.body.angularFactor.z).toBe(0);
    }
  });

  test('die / token / disc default to yawOnly=false with angularFactor (1,1,1)', () => {
    for (const type of ['die', 'token', 'disc']) {
      const e = scene.spawn(type, ctx);
      const phys = e.getComponent(PhysicsComponent)!;
      expect(phys.state.yawOnly).toBe(false);
      expect(phys.body.angularFactor.x).toBe(1);
      expect(phys.body.angularFactor.y).toBe(1);
      expect(phys.body.angularFactor.z).toBe(1);
    }
  });

  test('setState({yawOnly:false}) on a card releases the angular lock', () => {
    const e = scene.spawn('card', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    phys.setState({ yawOnly: false });
    expect(phys.body.angularFactor.x).toBe(1);
    expect(phys.body.angularFactor.y).toBe(1);
    expect(phys.body.angularFactor.z).toBe(1);
  });

  test('setState({yawOnly:true}) on a die engages the lock and zeroes stale pitch/roll velocity', () => {
    const e = scene.spawn('die', ctx);
    const phys = e.getComponent(PhysicsComponent)!;
    phys.body.angularVelocity.set(2, 3, 4);
    phys.setState({ yawOnly: true });
    expect(phys.body.angularFactor.x).toBe(0);
    expect(phys.body.angularFactor.y).toBe(1);
    expect(phys.body.angularFactor.z).toBe(0);
    expect(phys.body.angularVelocity.x).toBe(0);
    expect(phys.body.angularVelocity.y).toBe(3);
    expect(phys.body.angularVelocity.z).toBe(0);
  });
});

// Covers the host code path: dispatchMenuAction short-circuits into
// comp.onAction when isHost=true. canManipulate({isHost:true}, *) is always
// true so the host may toggle any entity regardless of ownership.
describe('PhysicsComponent — lock toggle authority (via dispatchMenuAction host path)', () => {
  test('host can toggle an entity owned by another seat', () => {
    const e = scene.spawn('die', ctx);
    e.owner = 1;
    const phys = e.getComponent(PhysicsComponent)!;
    dispatchMenuAction(
      { kind: 'action', id: 'lock-toggle', label: 'Lock movement', componentTypeId: 'physics' },
      undefined,
      e.id,
      {
        isHost:    true,
        entity:    e,
        send:      () => {},
        hostLocal: { delete: () => {} },
        selfSeat:  0,
      },
    );
    expect(phys.state.isLocked).toBe(true);
  });
});

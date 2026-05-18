import { describe, test, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { SceneImpl } from '../Scene';
import { type SpawnContext } from '../EntityComponent';
import { type Entity } from '../Entity';
import { TransformComponent } from './TransformComponent';
import { PhysicsComponent } from './PhysicsComponent';
import { ZoneComponent } from './ZoneComponent';
import { TweenComponent } from './TweenComponent';
import { registerCorePrimitives } from '../spawnables';
import { PhysicsWorld } from '../../physics/PhysicsWorld';
import { HostReplicatorV2, type ReplicatorPolicy } from '../HostReplicatorV2';
import { HostInputDispatcher } from '../HostInputDispatcher';
import { HoldService } from '../HoldService';
import { type SeatIndex } from '../../seats/SeatLayout';
import { createWorld } from '../world';

const POLICY: ReplicatorPolicy = {
  channelFor:  () => 'reliable',
  coalesceFor: () => 'merge',
  shouldFlush: () => true,
};

let scene:   SceneImpl;
let ctx:     SpawnContext;
let physics: PhysicsWorld;

beforeEach(() => {
  registerCorePrimitives();
  scene   = new SceneImpl();
  scene.world = new HostReplicatorV2(POLICY);
  physics = new PhysicsWorld();
  ctx     = { scene: new THREE.Scene(), physics, entityScene: scene };
});

function fireBeginContact(world: CANNON.World, bodyA: CANNON.Body, bodyB: CANNON.Body): void {
  world.dispatchEvent({ type: 'beginContact', bodyA, bodyB });
}

function fireEndContact(world: CANNON.World, bodyA: CANNON.Body, bodyB: CANNON.Body): void {
  world.dispatchEvent({ type: 'endContact', bodyA, bodyB });
}

describe('HostInputDispatcher.handlePlayCardToTable', () => {
  function setup(): { dispatcher: HostInputDispatcher; peerSeats: Map<string, SeatIndex> } {
    const peerSeats = new Map<string, SeatIndex>();
    const hold = new HoldService(scene.world as HostReplicatorV2, scene);
    const dispatcher = new HostInputDispatcher(
      hold,
      (peerId) => peerSeats.get(peerId) ?? null,
      scene,
    );
    return { dispatcher, peerSeats };
  }

  function setupHandWithCard(handOwner: SeatIndex | null): { hand: Entity; card: Entity } {
    const hand = scene.spawn('hand', ctx);
    hand.owner = handOwner;
    const card = scene.spawn('card', ctx);
    fireBeginContact(physics.world, hand.getComponent(ZoneComponent)!.body, card.getComponent(PhysicsComponent)!.body);
    // Settle the arrange-into-slot tween that the Hand fires on enter so
    // subsequent assertions can detect the play-to-table tween distinctly.
    card.getComponent(TweenComponent)!.snapToTarget();
    return { hand, card };
  }

  test('hand-owner seat may play their own card to the table', () => {
    const { dispatcher, peerSeats } = setup();
    const { card } = setupHandWithCard(1);
    peerSeats.set('p1', 1);

    const accepted = dispatcher.handlePlayCardToTable('p1', {
      type: 'play-card-to-table', entityId: card.id, x: 4, y: 1, z: 2,
    });
    expect(accepted).toBe(true);
    expect(card.getComponent(TweenComponent)!.isActive()).toBe(true);
  });

  test('non-owner seat is rejected', () => {
    const { dispatcher, peerSeats } = setup();
    const { card } = setupHandWithCard(1);
    peerSeats.set('p2', 2);

    const accepted = dispatcher.handlePlayCardToTable('p2', {
      type: 'play-card-to-table', entityId: card.id, x: 0, y: 0, z: 0,
    });
    expect(accepted).toBe(false);
    expect(card.getComponent(TweenComponent)!.isActive()).toBe(false);
  });

  test('shared (null-owner) hand accepts any seated peer', () => {
    const { dispatcher, peerSeats } = setup();
    const { card } = setupHandWithCard(null);
    peerSeats.set('p3', 3);

    const accepted = dispatcher.handlePlayCardToTable('p3', {
      type: 'play-card-to-table', entityId: card.id, x: 1, y: 1, z: 1,
    });
    expect(accepted).toBe(true);
  });

  test('spectator (no seat) is rejected', () => {
    const { dispatcher, peerSeats } = setup();
    const { card } = setupHandWithCard(0);
    peerSeats.set('px', 0);  // baseline accept
    peerSeats.delete('px');  // re-set as spectator

    const accepted = dispatcher.handlePlayCardToTable('px', {
      type: 'play-card-to-table', entityId: card.id, x: 0, y: 0, z: 0,
    });
    expect(accepted).toBe(false);
  });

  test('card not in any hand is rejected', () => {
    const { dispatcher, peerSeats } = setup();
    const card = scene.spawn('card', ctx);
    peerSeats.set('p1', 1);

    const accepted = dispatcher.handlePlayCardToTable('p1', {
      type: 'play-card-to-table', entityId: card.id, x: 0, y: 0, z: 0,
    });
    expect(accepted).toBe(false);
    expect(card.getComponent(TweenComponent)!.isActive()).toBe(false);
  });

  test('unknown entity id is rejected', () => {
    const { dispatcher, peerSeats } = setup();
    peerSeats.set('p1', 1);
    const accepted = dispatcher.handlePlayCardToTable('p1', {
      type: 'play-card-to-table', entityId: 'no-such-entity', x: 0, y: 0, z: 0,
    });
    expect(accepted).toBe(false);
  });

  test('accepted request triggers a tween that lands the card at the target', () => {
    const { dispatcher, peerSeats } = setup();
    const { card } = setupHandWithCard(1);
    peerSeats.set('p1', 1);

    dispatcher.handlePlayCardToTable('p1', {
      type: 'play-card-to-table', entityId: card.id, x: 7, y: 0.5, z: -3,
    });
    card.getComponent(TweenComponent)!.snapToTarget();

    const t = card.getComponent(TransformComponent)!.state.position;
    expect(t).toEqual([7, 0.5, -3]);
  });
});

describe('Play-to-table tween causes zone exit + privacy clear', () => {
  test('after tween moves card out of zone, endContact clears privateToSeat', () => {
    const hand = scene.spawn('hand', ctx);
    hand.owner = 1;
    const card = scene.spawn('card', ctx);
    const handZone = hand.getComponent(ZoneComponent)!;
    const cardBody = card.getComponent(PhysicsComponent)!.body;

    fireBeginContact(physics.world, handZone.body, cardBody);
    expect(card.privateToSeat).toBe(1);

    // Trigger play-to-table (host path).
    card.getComponent(TweenComponent)!.tweenTo({ position: [10, 0.5, 0] }, 250);
    card.getComponent(TweenComponent)!.snapToTarget();

    // Tween moved the body out of the zone; endContact fires (simulated here
    // since we're not running narrowphase).
    fireEndContact(physics.world, handZone.body, cardBody);
    expect(card.privateToSeat).toBeNull();
    expect(handZone.state.containedIds).not.toContain(card.id);
  });
});

describe('World.playCardToTable — host vs guest dispatch', () => {
  function trackingTransport(sent: unknown[]) {
    return {
      send: (msg: unknown) => { sent.push(msg); },
      sendTo: () => {},
      onMessage: () => () => {},
      onPeerJoin: () => () => {},
    };
  }

  test('host path runs the tween directly without an RPC', () => {
    const sent: unknown[] = [];
    const host = createWorld({
      role: 'host',
      scene: new THREE.Scene(),
      identity: { isHost: true, selfSeat: () => 0, selfPeerId: () => 'h' },
      transport: trackingTransport(sent),
    });
    try {
      const cardHandle = host.spawn('card', { id: 'c1', position: [0, 1, 0] });
      host.playCardToTable(cardHandle.entity, [3, 0.5, 4]);

      expect(cardHandle.get(TweenComponent)!.isActive()).toBe(true);
      const playMsgs = sent.filter(m => (m as { type?: string }).type === 'play-card-to-table');
      expect(playMsgs).toHaveLength(0);
    } finally {
      host.dispose();
    }
  });

  test('guest path emits a play-card-to-table envelope on the wire', () => {
    const sent: unknown[] = [];
    const guest = createWorld({
      role: 'guest',
      scene: new THREE.Scene(),
      identity: { isHost: false, selfSeat: () => 1, selfPeerId: () => 'g' },
      transport: trackingTransport(sent),
    });
    try {
      guest.loadSnapshot([{
        id: 'c1', type: 'card', name: 'Card-c1', tags: ['card'],
        owner: null, privateToSeat: null, parentId: null, children: [],
        components: {
          value:     { value: '', isNumeric: false },
          transform: { position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          mesh:      { meshRef: 'prim:card', textureRefs: { face: '', back: '' }, color: '#fafafa', width: 0.63, height: 0.01, depth: 0.88 },
          physics:   { mass: 0.05, friction: 0.6, restitution: 0.1, isLocked: false, yawOnly: true },
          flatview:  { textureRef: '' },
          card:      { face: '', back: '', category: '' },
          tween:     {},
        },
      }]);
      const cardHandle = guest.get('c1')!;

      guest.playCardToTable(cardHandle.entity, [3, 0.5, 4]);
      const playMsg = sent.find(m => (m as { type?: string }).type === 'play-card-to-table') as
        { type: string; entityId: string; x: number; y: number; z: number } | undefined;
      expect(playMsg).toBeDefined();
      expect(playMsg!.entityId).toBe('c1');
      expect(playMsg!.x).toBe(3);
      expect(playMsg!.y).toBe(0.5);
      expect(playMsg!.z).toBe(4);
    } finally {
      guest.dispose();
    }
  });
});

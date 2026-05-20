import { describe, test, expect, beforeEach } from 'vitest';
import { SceneImpl } from './Scene';
import { Entity } from './Entity';
import { ComponentRegistry } from './ComponentRegistry';
import { EntityComponent } from './EntityComponent';
import { HostReplicatorV2, type ReplicatorPolicy } from './HostReplicatorV2';
import { HoldService } from './HoldService';
import { HostInputDispatcher } from './HostInputDispatcher';
import { type DeckService } from './DeckService';
import { type BagService } from './BagService';
import { type PeelAndHoldResult } from './wire';
import { type SeatIndex } from '../seats/SeatLayout';
import { BagComponent } from './components/BagComponent';

const POLICY: ReplicatorPolicy = {
  channelFor:  () => 'reliable',
  coalesceFor: () => 'merge',
  shouldFlush: () => true,
};

// Per-component this.world is injected by SceneImpl.add (issue #6 of arch.md);
// the test rig sets scene.world to the replicator before adding entities so
// setState calls inside ValueComp.onPropertiesChanged still queue patches.

interface ValueState { v: number }
class ValueComp extends EntityComponent<ValueState> {
  static typeId = 'value';
  applied: Partial<ValueState>[] = [];
  invocations: Array<{ name: string }> = [];
  onSpawn() {}
  onPropertiesChanged(p: Partial<ValueState>) { this.applied.push(p); }
  onAction(name: string) {
    this.invocations.push({ name });
  }
}

let scene: SceneImpl;
let r: HostReplicatorV2;
let svc: HoldService;
let dispatcher: HostInputDispatcher;
const PEERS = new Map<string, SeatIndex | null>();

function spawn(id: string, owner: SeatIndex | null = null): Entity {
  const e = new Entity({ id, type: 'thing', name: id, owner });
  const v = new ValueComp();
  v.state = { v: 0 };
  e.attachComponent(v);
  scene.add(e);
  return e;
}

beforeEach(() => {
  scene = new SceneImpl();
  scene.setRegistry(new ComponentRegistry());
  PEERS.clear();
  r = new HostReplicatorV2(POLICY);
  scene.world = r;
  svc = new HoldService(r, scene);
  dispatcher = new HostInputDispatcher(svc, (peerId) => PEERS.get(peerId) ?? null, scene);
});

describe('HostInputDispatcher.handleHoldClaim — OwnershipPolicy gating', () => {
  test('owner-seated guest is accepted', () => {
    const e = spawn('a', 1);
    PEERS.set('p1', 1);
    expect(dispatcher.handleHoldClaim('p1', { type: 'hold-claim', entityId: 'a', seat: 1 })).toBe(true);
    expect(e.heldBy).toBe(1);
  });

  test('non-owner seated guest is refused', () => {
    const e = spawn('a', 1);
    PEERS.set('p2', 2);
    expect(dispatcher.handleHoldClaim('p2', { type: 'hold-claim', entityId: 'a', seat: 2 })).toBe(false);
    expect(e.heldBy).toBeNull();
  });

  test('spectator (peerSeat null) is refused', () => {
    const e = spawn('a', null);
    PEERS.set('p3', null);
    expect(dispatcher.handleHoldClaim('p3', { type: 'hold-claim', entityId: 'a', seat: null as unknown as SeatIndex })).toBe(false);
    expect(e.heldBy).toBeNull();
  });

  test('any seated guest may claim an unowned entity', () => {
    const e = spawn('a', null);
    PEERS.set('p4', 3);
    expect(dispatcher.handleHoldClaim('p4', { type: 'hold-claim', entityId: 'a', seat: 3 })).toBe(true);
    expect(e.heldBy).toBe(3);
  });

  test('claim refused if already held', () => {
    const e = spawn('a', null);
    e.heldBy = 1;
    PEERS.set('p2', 2);
    expect(dispatcher.handleHoldClaim('p2', { type: 'hold-claim', entityId: 'a', seat: 2 })).toBe(false);
    expect(e.heldBy).toBe(1);
  });

  test('unknown entity → refused', () => {
    expect(dispatcher.handleHoldClaim('px', { type: 'hold-claim', entityId: 'missing', seat: 1 })).toBe(false);
  });
});

describe('HostInputDispatcher.handleRequestUpdate — OwnershipPolicy gating', () => {
  test('owner-seated guest update is applied', () => {
    const e = spawn('a', 1);
    PEERS.set('p1', 1);
    expect(dispatcher.handleRequestUpdate('p1', {
      type: 'request-update', entityId: 'a', typeId: 'value', partial: { v: 7 },
    })).toBe(true);
    expect((e.components.get('value') as ValueComp).state.v).toBe(7);
  });

  test('non-owner seated guest update is refused', () => {
    const e = spawn('a', 1);
    PEERS.set('p2', 2);
    expect(dispatcher.handleRequestUpdate('p2', {
      type: 'request-update', entityId: 'a', typeId: 'value', partial: { v: 9 },
    })).toBe(false);
    expect((e.components.get('value') as ValueComp).state.v).toBe(0);
  });

  test('spectator update is refused', () => {
    const e = spawn('a', null);
    PEERS.set('p3', null);
    expect(dispatcher.handleRequestUpdate('p3', {
      type: 'request-update', entityId: 'a', typeId: 'value', partial: { v: 5 },
    })).toBe(false);
    expect((e.components.get('value') as ValueComp).state.v).toBe(0);
  });

  test('unknown component typeId → refused', () => {
    spawn('a', 1);
    PEERS.set('p1', 1);
    expect(dispatcher.handleRequestUpdate('p1', {
      type: 'request-update', entityId: 'a', typeId: 'nope', partial: {},
    })).toBe(false);
  });
});

describe('HostInputDispatcher.handleInvokeAction — slice #7', () => {
  test('owner-seated guest invocation is applied', () => {
    const e = spawn('a', 1);
    PEERS.set('p1', 1);
    expect(dispatcher.handleInvokeAction('p1', {
      type: 'invoke-action', entityId: 'a', componentTypeId: 'value',
      actionId: 'roll',
    })).toBe(true);
    const tracker = e.components.get('value') as ValueComp;
    expect(tracker.invocations).toEqual([{ name: 'roll' }]);
  });

  test('non-owner invocation is refused', () => {
    const e = spawn('a', 1);
    PEERS.set('p2', 2);
    expect(dispatcher.handleInvokeAction('p2', {
      type: 'invoke-action', entityId: 'a', componentTypeId: 'value',
      actionId: 'roll',
    })).toBe(false);
    const tracker = e.components.get('value') as ValueComp;
    expect(tracker.invocations).toEqual([]);
  });

  test('spectator invocation is refused', () => {
    const e = spawn('a', null);
    PEERS.set('p3', null);
    expect(dispatcher.handleInvokeAction('p3', {
      type: 'invoke-action', entityId: 'a', componentTypeId: 'value', actionId: 'roll',
    })).toBe(false);
    const tracker = e.components.get('value') as ValueComp;
    expect(tracker.invocations).toEqual([]);
  });

  test('unknown component → refused', () => {
    spawn('a', 1);
    PEERS.set('p1', 1);
    expect(dispatcher.handleInvokeAction('p1', {
      type: 'invoke-action', entityId: 'a', componentTypeId: 'nope', actionId: 'roll',
    })).toBe(false);
  });

  test('unknown entity → refused', () => {
    PEERS.set('p1', 1);
    expect(dispatcher.handleInvokeAction('p1', {
      type: 'invoke-action', entityId: 'missing', componentTypeId: 'value', actionId: 'roll',
    })).toBe(false);
  });
});

describe('HostInputDispatcher.handleHoldRelease', () => {
  test('release succeeds when sender holds the entity', () => {
    const e = spawn('a', null);
    PEERS.set('p1', 1);
    svc.tryClaim(e, 1);
    r.flushReliable();

    expect(dispatcher.handleHoldRelease('p1', {
      type: 'hold-release', entityId: 'a', vx: 1, vy: 0, vz: 2,
    })).toBe(true);
    expect(e.heldBy).toBeNull();
  });

  test('release refused when sender is not the holder', () => {
    const e = spawn('a', null);
    PEERS.set('p1', 1);
    PEERS.set('p2', 2);
    svc.tryClaim(e, 1);
    r.flushReliable();

    expect(dispatcher.handleHoldRelease('p2', { type: 'hold-release', entityId: 'a' })).toBe(false);
    expect(e.heldBy).toBe(1);
  });
});

describe('HostInputDispatcher.handlePeelAndHold — issue #3 of issues--deck-peel.md', () => {
  let peelCalls: Array<{ deckId: string; seat: SeatIndex }>;
  let peelResult: PeelAndHoldResult | null;

  function stubDeckService(): void {
    peelCalls = [];
    peelResult = { cardId: 'card-1', pos: [0, 0, 0], rot: [0, 0, 0, 1] };
    const stub = {
      peelTop: (deckId: string, seat: SeatIndex) => {
        peelCalls.push({ deckId, seat });
        return peelResult;
      },
    } as unknown as DeckService;
    dispatcher.setDeckService(stub);
  }

  test('owner-seated guest peel — calls peelTop and returns its result', () => {
    spawn('deck-1', 1);
    PEERS.set('p1', 1);
    stubDeckService();

    const result = dispatcher.handlePeelAndHold('p1', {
      type: 'peel-and-hold', requestId: 'r1', deckId: 'deck-1',
    });

    expect(result).toEqual({ cardId: 'card-1', pos: [0, 0, 0], rot: [0, 0, 0, 1] });
    expect(peelCalls).toEqual([{ deckId: 'deck-1', seat: 1 }]);
  });

  test('non-owner seated guest is refused — peelTop not called', () => {
    spawn('deck-1', 1);
    PEERS.set('p2', 2);
    stubDeckService();

    const result = dispatcher.handlePeelAndHold('p2', {
      type: 'peel-and-hold', requestId: 'r2', deckId: 'deck-1',
    });

    expect(result).toBeNull();
    expect(peelCalls).toEqual([]);
  });

  test('spectator (peerSeat null) is refused — peelTop not called', () => {
    spawn('deck-1', null);
    PEERS.set('p3', null);
    stubDeckService();

    const result = dispatcher.handlePeelAndHold('p3', {
      type: 'peel-and-hold', requestId: 'r3', deckId: 'deck-1',
    });

    expect(result).toBeNull();
    expect(peelCalls).toEqual([]);
  });

  test('any seated guest may peel from an unowned deck', () => {
    spawn('deck-1', null);
    PEERS.set('p4', 3);
    stubDeckService();

    const result = dispatcher.handlePeelAndHold('p4', {
      type: 'peel-and-hold', requestId: 'r4', deckId: 'deck-1',
    });

    expect(result).not.toBeNull();
    expect(peelCalls).toEqual([{ deckId: 'deck-1', seat: 3 }]);
  });

  test('unknown deck id is refused — peelTop not called', () => {
    PEERS.set('p1', 1);
    stubDeckService();

    const result = dispatcher.handlePeelAndHold('p1', {
      type: 'peel-and-hold', requestId: 'r5', deckId: 'missing',
    });

    expect(result).toBeNull();
    expect(peelCalls).toEqual([]);
  });

  test('returns null when DeckService is not wired', () => {
    spawn('deck-1', 1);
    PEERS.set('p1', 1);
    // No setDeckService call.
    const result = dispatcher.handlePeelAndHold('p1', {
      type: 'peel-and-hold', requestId: 'r6', deckId: 'deck-1',
    });
    expect(result).toBeNull();
  });

  test('propagates peelTop null (empty deck, defensive failure, etc.)', () => {
    spawn('deck-1', 1);
    PEERS.set('p1', 1);
    stubDeckService();
    peelResult = null;

    const result = dispatcher.handlePeelAndHold('p1', {
      type: 'peel-and-hold', requestId: 'r7', deckId: 'deck-1',
    });

    expect(result).toBeNull();
    // peelTop was called — the null comes from the service, not the gate.
    expect(peelCalls).toEqual([{ deckId: 'deck-1', seat: 1 }]);
  });
});

describe('HostInputDispatcher.handlePeelAndHold — bag routing (issue #3 of issues--bag.md)', () => {
  let bagPickCalls: Array<{ bagId: string; seat: SeatIndex }>;
  let bagPickResult: PeelAndHoldResult | null;
  let deckPeelCalls: Array<{ deckId: string; seat: SeatIndex }>;

  function spawnBag(id: string, owner: SeatIndex | null = null): Entity {
    const e = new Entity({ id, type: 'bag', name: id, owner });
    const bag = new BagComponent();
    bag.fromJSON({ contents: [] });
    e.attachComponent(bag);
    scene.add(e);
    return e;
  }

  function stubBagService(): void {
    bagPickCalls = [];
    bagPickResult = { cardId: 'item-1', pos: [1, 2, 3], rot: [0, 0, 0, 1] };
    const stub = {
      pickRandom: (bagId: string, seat: SeatIndex) => {
        bagPickCalls.push({ bagId, seat });
        return bagPickResult;
      },
    } as unknown as BagService;
    dispatcher.setBagService(stub);
  }

  function stubDeckServiceForRouting(): void {
    deckPeelCalls = [];
    const stub = {
      peelTop: (deckId: string, seat: SeatIndex) => {
        deckPeelCalls.push({ deckId, seat });
        return null;
      },
    } as unknown as DeckService;
    dispatcher.setDeckService(stub);
  }

  test('entity with BagComponent routes to BagService.pickRandom, not DeckService.peelTop', () => {
    spawnBag('bag-1', 1);
    PEERS.set('p1', 1);
    stubBagService();
    stubDeckServiceForRouting();

    const result = dispatcher.handlePeelAndHold('p1', {
      type: 'peel-and-hold', requestId: 'r1', deckId: 'bag-1',
    });

    expect(result).toEqual({ cardId: 'item-1', pos: [1, 2, 3], rot: [0, 0, 0, 1] });
    expect(bagPickCalls).toEqual([{ bagId: 'bag-1', seat: 1 }]);
    expect(deckPeelCalls).toEqual([]);
  });

  test('owned bag refuses pick from a non-owner seat', () => {
    spawnBag('bag-1', 1);
    PEERS.set('p2', 2);
    stubBagService();

    const result = dispatcher.handlePeelAndHold('p2', {
      type: 'peel-and-hold', requestId: 'r2', deckId: 'bag-1',
    });
    expect(result).toBeNull();
    expect(bagPickCalls).toEqual([]);
  });

  test('returns null when BagService is not wired', () => {
    spawnBag('bag-1', 1);
    PEERS.set('p1', 1);
    // No setBagService call.

    const result = dispatcher.handlePeelAndHold('p1', {
      type: 'peel-and-hold', requestId: 'r3', deckId: 'bag-1',
    });
    expect(result).toBeNull();
  });
});

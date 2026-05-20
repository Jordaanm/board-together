import { describe, test, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { SceneImpl } from '../entity/Scene';
import { type SpawnContext } from '../entity/EntityComponent';
import { HostReplicatorV2, type ReplicatorPolicy } from '../entity/HostReplicatorV2';
import { MergeService } from '../entity/MergeService';
import { BagService } from '../entity/BagService';
import { registerCorePrimitives } from '../entity/spawnables';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { entityToSerialized } from '../entity/Scene';
import { BagComponent } from '../entity/components/BagComponent';
import { TransformComponent } from '../entity/components/TransformComponent';
import { SceneFacade } from './SceneFacade';
import { type ScriptRunContext } from './EntityFacade';
import { type Entity } from '../entity/Entity';

const POLICY: ReplicatorPolicy = {
  channelFor:  () => 'reliable',
  coalesceFor: () => 'merge',
  shouldFlush: () => true,
};

let scene:      SceneImpl;
let ctx:        SpawnContext;
let replicator: HostReplicatorV2;
let merge:      MergeService;
let bagSvc:     BagService;
let runCtx:     ScriptRunContext;
let sceneFacade: SceneFacade;

function absorb(bag: Entity, item: Entity): void {
  merge.noteBeginContact(item, bag);
  merge.recheckMergeOverlaps(item);
}

beforeEach(() => {
  registerCorePrimitives();
  scene = new SceneImpl();
  ctx = { scene: new THREE.Scene(), physics: new PhysicsWorld(), entityScene: scene };
  replicator = new HostReplicatorV2(POLICY);
  scene.world = replicator;
  merge = new MergeService(scene, replicator, {
    spawnAt: (type, position) => {
      const e = scene.spawn(type, ctx);
      const t = e.getComponent(TransformComponent)!;
      t.setState({ position, rotation: t.state.rotation, scale: t.state.scale });
      return e;
    },
  });
  bagSvc = new BagService(scene, replicator, {
    tryHold: () => true,
    releaseHold: () => {},
  });
  runCtx = { registrations: [] };
  sceneFacade = new SceneFacade(scene, runCtx, {
    bagOps: {
      add:        (bagId, entityId) => bagSvc.addToBag(bagId, entityId),
      remove:     (bagId, entityId) => bagSvc.removeFromBag(bagId, entityId),
      pickRandom: (bagId) => bagSvc.pickRandomNoHold(bagId),
    },
  });
});

describe('EntityFacade.bag — getter', () => {
  test('returns a BagFacade for an entity carrying BagComponent', () => {
    const bag = scene.spawn('bag', ctx);
    const facade = sceneFacade.getObjectById(bag.id)!;
    expect(facade.bag).not.toBeNull();
  });

  test('returns null for any other entity', () => {
    const die = scene.spawn('die', ctx);
    const facade = sceneFacade.getObjectById(die.id)!;
    expect(facade.bag).toBeNull();
  });
});

describe('BagFacade.add', () => {
  test('moves a loose entity into the bag (parentId, isContained, contents)', () => {
    const bag = scene.spawn('bag', ctx);
    const die = scene.spawn('die', ctx);
    const facade = sceneFacade.getObjectById(bag.id)!;
    expect(facade.bag!.add(sceneFacade.getObjectById(die.id))).toBe(true);
    expect(bag.getComponent(BagComponent)!.state.contents).toContain(die.id);
    expect(die.parentId).toBe(bag.id);
    expect(die.isContained).toBe(true);
  });

  test('moves an item out of a prior bag into the new one', () => {
    const bagA = scene.spawn('bag', ctx);
    const bagB = scene.spawn('bag', ctx);
    const die = scene.spawn('die', ctx);
    absorb(bagA, die);
    expect(bagA.getComponent(BagComponent)!.state.contents).toContain(die.id);

    const facadeB = sceneFacade.getObjectById(bagB.id)!;
    expect(facadeB.bag!.add(sceneFacade.getObjectById(die.id))).toBe(true);

    expect(bagA.getComponent(BagComponent)!.state.contents).not.toContain(die.id);
    expect(bagB.getComponent(BagComponent)!.state.contents).toContain(die.id);
    expect(die.parentId).toBe(bagB.id);
    expect(die.isContained).toBe(true);
  });

  test('accepts a raw id string', () => {
    const bag = scene.spawn('bag', ctx);
    const die = scene.spawn('die', ctx);
    const facade = sceneFacade.getObjectById(bag.id)!;
    expect(facade.bag!.add(die.id)).toBe(true);
    expect(bag.getComponent(BagComponent)!.state.contents).toContain(die.id);
  });

  test('returns false when the entity is missing / invalid', () => {
    const bag = scene.spawn('bag', ctx);
    const facade = sceneFacade.getObjectById(bag.id)!;
    expect(facade.bag!.add(null)).toBe(false);
    expect(facade.bag!.add(undefined)).toBe(false);
    expect(facade.bag!.add('nonexistent')).toBe(false);
  });

  test('refuses to add a Zone-bearing entity (canAccept gate)', () => {
    const bag = scene.spawn('bag', ctx);
    const hand = scene.spawn('hand', ctx);
    const facade = sceneFacade.getObjectById(bag.id)!;
    expect(facade.bag!.add(hand.id)).toBe(false);
  });
});

describe('BagFacade.remove', () => {
  test('extracts an item from the bag, returns true', () => {
    const bag = scene.spawn('bag', ctx);
    const die = scene.spawn('die', ctx);
    absorb(bag, die);
    const facade = sceneFacade.getObjectById(bag.id)!;
    expect(facade.bag!.remove(die.id)).toBe(true);
    expect(bag.getComponent(BagComponent)!.state.contents).not.toContain(die.id);
    expect(die.parentId).toBeNull();
    expect(die.isContained).toBe(false);
  });

  test('returns false when the entity is not in the bag', () => {
    const bag = scene.spawn('bag', ctx);
    const die = scene.spawn('die', ctx);  // loose; never absorbed
    const facade = sceneFacade.getObjectById(bag.id)!;
    expect(facade.bag!.remove(die.id)).toBe(false);
    expect(die.parentId).toBeNull();
    expect(die.isContained).toBe(false);
  });

  test('accepts an EntityFacade argument', () => {
    const bag = scene.spawn('bag', ctx);
    const die = scene.spawn('die', ctx);
    absorb(bag, die);
    const facade = sceneFacade.getObjectById(bag.id)!;
    expect(facade.bag!.remove(sceneFacade.getObjectById(die.id))).toBe(true);
  });
});

describe('BagFacade.contents', () => {
  test('returns a fresh array — mutating it does not affect the bag', () => {
    const bag = scene.spawn('bag', ctx);
    const die = scene.spawn('die', ctx);
    absorb(bag, die);
    const facade = sceneFacade.getObjectById(bag.id)!.bag!;
    const arr = facade.contents();
    expect(arr.length).toBe(1);
    arr.length = 0;
    expect(facade.contents().length).toBe(1);
  });

  test('subsequent add/remove does not affect previously-returned snapshots', () => {
    const bag = scene.spawn('bag', ctx);
    const die = scene.spawn('die', ctx);
    absorb(bag, die);
    const facade = sceneFacade.getObjectById(bag.id)!.bag!;
    const snap = facade.contents();
    facade.remove(die.id);
    expect(snap.length).toBe(1);
    expect(snap[0].id).toBe(die.id);
  });
});

describe('BagFacade.pickRandom', () => {
  test('non-empty bag returns a facade and removes the item', () => {
    const bag = scene.spawn('bag', ctx);
    const die = scene.spawn('die', ctx);
    absorb(bag, die);
    const facade = sceneFacade.getObjectById(bag.id)!.bag!;
    const picked = facade.pickRandom();
    expect(picked).not.toBeNull();
    expect(picked!.id).toBe(die.id);
    expect(bag.getComponent(BagComponent)!.state.contents).not.toContain(die.id);
  });

  test('empty bag returns null', () => {
    const bag = scene.spawn('bag', ctx);
    const facade = sceneFacade.getObjectById(bag.id)!.bag!;
    expect(facade.pickRandom()).toBeNull();
  });
});

describe('BagFacade.has / size', () => {
  test('reflect current membership', () => {
    const bag = scene.spawn('bag', ctx);
    const die = scene.spawn('die', ctx);
    const facade = sceneFacade.getObjectById(bag.id)!.bag!;
    expect(facade.size()).toBe(0);
    expect(facade.has(die.id)).toBe(false);
    absorb(bag, die);
    expect(facade.size()).toBe(1);
    expect(facade.has(die.id)).toBe(true);
    facade.remove(die.id);
    expect(facade.size()).toBe(0);
    expect(facade.has(die.id)).toBe(false);
  });
});

describe('BagFacade — save/load round-trip', () => {
  test('a bag with mixed contents survives Scene.load with parentId / isContained / contents preserved', () => {
    const bag = scene.spawn('bag', ctx);
    const die = scene.spawn('die', ctx);
    const token = scene.spawn('token', ctx);
    absorb(bag, die);
    absorb(bag, token);
    const snaps = scene.all().map(e => entityToSerialized(e));

    const fresh = new SceneImpl();
    const freshCtx: SpawnContext = { scene: new THREE.Scene(), physics: new PhysicsWorld(), entityScene: fresh };
    fresh.load(snaps, freshCtx);

    const newBag = fresh.getEntity(bag.id)!;
    const newDie = fresh.getEntity(die.id)!;
    const newToken = fresh.getEntity(token.id)!;
    const newBagC = newBag.getComponent(BagComponent)!;
    expect(newBagC.state.contents).toEqual(bag.getComponent(BagComponent)!.state.contents);
    expect(newDie.parentId).toBe(bag.id);
    expect(newDie.isContained).toBe(true);
    expect(newToken.parentId).toBe(bag.id);
    expect(newToken.isContained).toBe(true);
  });
});

describe('BagFacade — guest (no bagOps wired)', () => {
  test('add / remove / pickRandom no-op and return false / null', () => {
    const guestRunCtx: ScriptRunContext = { registrations: [], warn: () => {} };
    const guestSceneFacade = new SceneFacade(scene, guestRunCtx, {});
    const bag = scene.spawn('bag', ctx);
    const die = scene.spawn('die', ctx);
    const facade = guestSceneFacade.getObjectById(bag.id)!.bag!;
    expect(facade.add(die.id)).toBe(false);
    expect(facade.remove(die.id)).toBe(false);
    expect(facade.pickRandom()).toBeNull();
    // Read-only methods still work without bagOps.
    expect(facade.size()).toBe(0);
    expect(facade.has(die.id)).toBe(false);
  });
});

describe('BagFacade — owner-gating is host-side; scripts bypass', () => {
  test('add/remove/pickRandom succeed regardless of bag.owner', () => {
    const bag = scene.spawn('bag', ctx);
    bag.owner = 1;
    const die = scene.spawn('die', ctx);
    const facade = sceneFacade.getObjectById(bag.id)!.bag!;
    expect(facade.add(die.id)).toBe(true);
    expect(facade.pickRandom()).not.toBeNull();
  });
});

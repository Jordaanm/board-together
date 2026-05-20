import { describe, test, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { SceneImpl } from './Scene';
import { type SpawnContext } from './EntityComponent';
import { HostReplicatorV2, type ReplicatorPolicy } from './HostReplicatorV2';
import { MergeService } from './MergeService';
import { BagService } from './BagService';
import { registerCorePrimitives } from './spawnables';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { BagComponent } from './components/BagComponent';
import { TransformComponent } from './components/TransformComponent';
import { type Entity } from './Entity';

const POLICY: ReplicatorPolicy = {
  channelFor:  () => 'reliable',
  coalesceFor: () => 'merge',
  shouldFlush: () => true,
};

let scene:      SceneImpl;
let ctx:        SpawnContext;
let replicator: HostReplicatorV2;
let merge:      MergeService;
let bags:       BagService;
let heldEntities: { id: string; seat: number }[];

function makeBagWithContents(itemTypes: string[]): { bag: Entity; items: Entity[] } {
  const bag = scene.spawn('bag', ctx);
  const items: Entity[] = [];
  for (const type of itemTypes) {
    const item = scene.spawn(type, ctx);
    items.push(item);
    merge.noteBeginContact(item, bag);
    merge.recheckMergeOverlaps(item);
  }
  return { bag, items };
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
  heldEntities = [];
  bags = new BagService(scene, replicator, {
    tryHold: (e, seat) => {
      e.heldBy = seat as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
      heldEntities.push({ id: e.id, seat });
      return true;
    },
    releaseHold: (e) => { e.heldBy = null; },
  });
});

describe('BagService.pickRandom', () => {
  test('non-empty bag pops one item, restores parentId/isContained, claims hold', () => {
    const { bag, items } = makeBagWithContents(['die', 'die', 'die']);
    expect(bag.getComponent(BagComponent)!.state.contents.length).toBe(3);

    const result = bags.pickRandom(bag.id, 1);
    expect(result).not.toBeNull();
    const pickedId = result!.cardId;
    const picked = scene.getEntity(pickedId)!;
    expect(items.some(i => i.id === pickedId)).toBe(true);
    expect(bag.getComponent(BagComponent)!.state.contents).not.toContain(pickedId);
    expect(bag.getComponent(BagComponent)!.state.contents.length).toBe(2);
    expect(picked.parentId).toBeNull();
    expect(picked.isContained).toBe(false);
    expect(picked.heldBy).toBe(1);
    expect(bag.children).not.toContain(pickedId);
  });

  test('empty bag returns null', () => {
    const bag = scene.spawn('bag', ctx);
    expect(bags.pickRandom(bag.id, 0)).toBeNull();
  });

  test('unknown bag id returns null', () => {
    expect(bags.pickRandom('nonexistent', 0)).toBeNull();
  });

  test('entity without BagComponent returns null', () => {
    const die = scene.spawn('die', ctx);
    expect(bags.pickRandom(die.id, 0)).toBeNull();
  });

  test('with seeded RNG, repeated picks cover every index', () => {
    // Construct a bag with N items, then repeatedly pickRandom + re-absorb
    // with the bag held to a sequence of seeded RNG values.
    const N = 5;
    let rngIndex = 0;
    const sequence = [0.0, 0.2, 0.4, 0.6, 0.8];  // each maps to a distinct floor() bucket of 5.
    const bagsSeeded = new BagService(scene, replicator, {
      tryHold: (e, seat) => {
        e.heldBy = seat as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
        return true;
      },
      releaseHold: (e) => { e.heldBy = null; },
    }, () => sequence[(rngIndex++) % sequence.length]);

    const { bag } = makeBagWithContents(Array(N).fill('die'));
    const picked = new Set<string>();
    for (let i = 0; i < N; i++) {
      const result = bagsSeeded.pickRandom(bag.id, 0);
      expect(result).not.toBeNull();
      picked.add(result!.cardId);
      // Don't re-absorb — bag shrinks naturally.
    }
    // Every index in the original contents should have been picked exactly once.
    expect(picked.size).toBe(N);
  });

  test('emits component-patch on bag (contents) + entity-patch on picked (parentId, isContained)', () => {
    const { bag, items } = makeBagWithContents(['die']);
    replicator.flushReliable();  // clear earlier patches.

    const result = bags.pickRandom(bag.id, 0);
    expect(result).not.toBeNull();
    const pickedId = result!.cardId;

    const messages = replicator.flushReliable();
    const entityPatches: Array<{ entityId: string; partial: Record<string, unknown> }> = [];
    const componentPatches: Array<{ entityId: string; typeId: string; partial: Record<string, unknown> }> = [];
    for (const m of messages) {
      if (m.type === 'entity-patch') {
        entityPatches.push({ entityId: m.entityId, partial: m.partial });
      } else if (m.type === 'component-patches') {
        for (const p of m.patches) {
          componentPatches.push({ entityId: p.entityId, typeId: p.typeId, partial: p.partial });
        }
      }
    }
    expect(entityPatches.some(p => p.entityId === pickedId && p.partial.isContained === false)).toBe(true);
    expect(entityPatches.some(p => p.entityId === pickedId && p.partial.parentId === null)).toBe(true);
    expect(componentPatches.some(p =>
      p.entityId === bag.id && p.typeId === 'bag' &&
      Array.isArray(p.partial.contents) && (p.partial.contents as string[]).length === 0
    )).toBe(true);
    // Acknowledge items reference used; silences lint warning.
    expect(items.length).toBe(1);
  });

  test('releasing the picked item back over the same bag re-absorbs it', () => {
    const { bag, items } = makeBagWithContents(['die']);
    const result = bags.pickRandom(bag.id, 0);
    expect(result).not.toBeNull();
    const picked = scene.getEntity(result!.cardId)!;
    picked.heldBy = null;  // simulate release.
    // Recheck the merge overlaps using the existing contact set.
    merge.recheckMergeOverlaps(picked);
    expect(bag.getComponent(BagComponent)!.state.contents).toContain(picked.id);
    expect(picked.parentId).toBe(bag.id);
    expect(picked.isContained).toBe(true);
    // Acknowledge items reference; silences lint warning.
    expect(items.length).toBe(1);
  });
});

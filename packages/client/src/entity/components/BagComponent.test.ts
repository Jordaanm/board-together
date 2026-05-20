import { describe, test, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { SceneImpl } from '../Scene';
import { type SpawnContext } from '../EntityComponent';
import { registerCorePrimitives } from '../spawnables';
import { PhysicsWorld } from '../../physics/PhysicsWorld';
import { entityToSerialized } from '../Scene';
import { BagComponent } from './BagComponent';

let scene: SceneImpl;
let ctx: SpawnContext;

beforeEach(() => {
  registerCorePrimitives();
  scene = new SceneImpl();
  ctx = { scene: new THREE.Scene(), physics: new PhysicsWorld(), entityScene: scene };
});

describe('BagComponent — registration + spawn', () => {
  test('bag spawnable spawns with default leather-brown cube mesh', () => {
    const bag = scene.spawn('bag', ctx);
    const bagC = bag.getComponent(BagComponent);
    expect(bagC).toBeDefined();
    expect(bagC!.state.contents).toEqual([]);
    expect(bagC!.state.acceptComponents).toBeUndefined();
  });
});

describe('BagComponent — serialization', () => {
  test('toJSON / fromJSON round-trip preserves empty contents', () => {
    const bag = scene.spawn('bag', ctx);
    const bagC = bag.getComponent(BagComponent)!;
    const json = bagC.toJSON();
    const fresh = new BagComponent();
    fresh.fromJSON(json);
    expect(fresh.state.contents).toEqual([]);
    expect(fresh.state.acceptComponents).toBeUndefined();
  });

  test('toJSON / fromJSON round-trip preserves populated contents', () => {
    const bag = scene.spawn('bag', ctx);
    const bagC = bag.getComponent(BagComponent)!;
    bagC.state.contents = ['a', 'b', 'c'];
    bagC.state.acceptComponents = ['mesh', 'physics'];
    const json = bagC.toJSON();
    const fresh = new BagComponent();
    fresh.fromJSON(json);
    expect(fresh.state.contents).toEqual(['a', 'b', 'c']);
    expect(fresh.state.acceptComponents).toEqual(['mesh', 'physics']);
  });

  test('toJSON returns fresh array (mutation does not leak)', () => {
    const bag = scene.spawn('bag', ctx);
    const bagC = bag.getComponent(BagComponent)!;
    bagC.state.contents = ['a'];
    const json = bagC.toJSON() as { contents: string[] };
    json.contents.push('b');
    expect(bagC.state.contents).toEqual(['a']);
  });
});

describe('BagComponent.canAccept', () => {
  test('accepts a plain entity (transform + mesh + physics)', () => {
    const bag = scene.spawn('bag', ctx);
    const die = scene.spawn('die', ctx);
    expect(bag.getComponent(BagComponent)!.canAccept(die)).toBe(true);
  });

  test('refuses a Zone-bearing entity', () => {
    const bag = scene.spawn('bag', ctx);
    const zone = scene.spawn('zone', ctx);
    expect(bag.getComponent(BagComponent)!.canAccept(zone)).toBe(false);
  });

  test('refuses the Table singleton', () => {
    const bag = scene.spawn('bag', ctx);
    const table = scene.spawn('table', ctx);
    expect(bag.getComponent(BagComponent)!.canAccept(table)).toBe(false);
  });

  test('refuses a SnapPoints-bearing entity (zone-style)', () => {
    const bag = scene.spawn('bag', ctx);
    const snap = scene.spawn('snap-marker', ctx);
    expect(bag.getComponent(BagComponent)!.canAccept(snap)).toBe(false);
  });

  test('refuses an ancestor of the bag (cycle guard)', () => {
    const outer = scene.spawn('bag', ctx);
    const inner = scene.spawn('bag', ctx);
    inner.parentId = outer.id;
    // Dropping outer onto inner would put outer inside one of its own descendants.
    expect(inner.getComponent(BagComponent)!.canAccept(outer)).toBe(false);
  });

  test('refuses the bag itself', () => {
    const bag = scene.spawn('bag', ctx);
    expect(bag.getComponent(BagComponent)!.canAccept(bag)).toBe(false);
  });

  test('respects acceptComponents whitelist — accepts when filter matches', () => {
    const bag = scene.spawn('bag', ctx);
    const die = scene.spawn('die', ctx);
    bag.getComponent(BagComponent)!.state.acceptComponents = ['dice'];
    expect(bag.getComponent(BagComponent)!.canAccept(die)).toBe(true);
  });

  test('respects acceptComponents whitelist — refuses when filter excludes', () => {
    const bag = scene.spawn('bag', ctx);
    const token = scene.spawn('token', ctx);
    bag.getComponent(BagComponent)!.state.acceptComponents = ['dice'];
    expect(bag.getComponent(BagComponent)!.canAccept(token)).toBe(false);
  });

  test('accepts another bag (bags-in-bags allowed)', () => {
    const outer = scene.spawn('bag', ctx);
    const inner = scene.spawn('bag', ctx);
    expect(outer.getComponent(BagComponent)!.canAccept(inner)).toBe(true);
  });
});

describe('BagComponent.onTryGrab', () => {
  test('empty bag short-press returns null (falls through to whole-entity carry)', () => {
    const bag = scene.spawn('bag', ctx);
    expect(bag.getComponent(BagComponent)!.onTryGrab(false)).toBeNull();
  });

  test('empty bag long-press returns null (falls through to whole-entity carry)', () => {
    const bag = scene.spawn('bag', ctx);
    expect(bag.getComponent(BagComponent)!.onTryGrab(true)).toBeNull();
  });

  test('non-empty bag short-press returns peel intent with the bag id', () => {
    const bag = scene.spawn('bag', ctx);
    bag.getComponent(BagComponent)!.state.contents = ['die-1'];
    expect(bag.getComponent(BagComponent)!.onTryGrab(false)).toEqual({
      kind:     'peel',
      sourceId: bag.id,
    });
  });

  test('non-empty bag long-press returns null (whole-bag carry falls through)', () => {
    const bag = scene.spawn('bag', ctx);
    bag.getComponent(BagComponent)!.state.contents = ['die-1'];
    expect(bag.getComponent(BagComponent)!.onTryGrab(true)).toBeNull();
  });
});

describe('BagComponent — save/load round-trip', () => {
  test('empty bag survives entityToSerialized + Scene.load', () => {
    const bag = scene.spawn('bag', ctx);
    const snap = entityToSerialized(bag);

    const fresh = new SceneImpl();
    const freshCtx: SpawnContext = { scene: new THREE.Scene(), physics: new PhysicsWorld(), entityScene: fresh };
    const [loaded] = fresh.load([snap], freshCtx);
    expect(loaded.type).toBe('bag');
    expect(loaded.name).toBe(bag.name);
    const bagC = loaded.getComponent(BagComponent);
    expect(bagC).toBeDefined();
    expect(bagC!.state.contents).toEqual([]);
  });
});

describe('BagComponent — cascade despawn', () => {
  test('despawning a bag with a parented content also despawns the content', () => {
    const bag = scene.spawn('bag', ctx);
    const die = scene.spawn('die', ctx);
    die.parentId = bag.id;
    bag.children = [die.id];
    bag.getComponent(BagComponent)!.state.contents = [die.id];

    const removed = scene.despawn(bag.id, ctx);
    expect(removed).toContain(bag.id);
    expect(removed).toContain(die.id);
    expect(scene.getEntity(bag.id)).toBeUndefined();
    expect(scene.getEntity(die.id)).toBeUndefined();
  });
});

import { describe, test, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { SceneImpl } from '../entity/Scene';
import { type SpawnContext } from '../entity/EntityComponent';
import { registerCorePrimitives } from '../entity/spawnables';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { BagComponent } from '../entity/components/BagComponent';
import { DeckComponent } from '../entity/components/DeckComponent';
import { resolveContainerTooltip } from './HoverTooltipOverlay';

let scene: SceneImpl;
let ctx: SpawnContext;

beforeEach(() => {
  registerCorePrimitives();
  scene = new SceneImpl();
  ctx = { scene: new THREE.Scene(), physics: new PhysicsWorld(), entityScene: scene };
});

describe('resolveContainerTooltip', () => {
  test('returns null for a non-container entity (die)', () => {
    const die = scene.spawn('die', ctx);
    expect(resolveContainerTooltip(die)).toBeNull();
  });

  test('returns count + label for a bag', () => {
    const bag = scene.spawn('bag', ctx);
    bag.getComponent(BagComponent)!.state.contents = ['a', 'b', 'c'];
    bag.getComponent(BagComponent)!.state.label    = 'dice';
    expect(resolveContainerTooltip(bag)).toEqual({ count: 3, label: 'dice' });
  });

  test('returns count + label for a deck', () => {
    const deck = scene.spawn('deck', ctx);
    deck.getComponent(DeckComponent)!.setState({ cards: ['x', 'y'], label: 'spells' });
    expect(resolveContainerTooltip(deck)).toEqual({ count: 2, label: 'spells' });
  });

  test('reports zero count for an empty container', () => {
    const bag = scene.spawn('bag', ctx);
    expect(resolveContainerTooltip(bag)).toEqual({ count: 0, label: 'items' });
  });
});

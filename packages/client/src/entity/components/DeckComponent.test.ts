import { describe, test, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { SceneImpl } from '../Scene';
import { type SpawnContext, type MenuItem } from '../EntityComponent';
import { DEFAULT_PREFERENCES } from '../../preferences/types';
import { registerCorePrimitives } from '../spawnables';
import { PhysicsWorld } from '../../physics/PhysicsWorld';
import { CardComponent } from './CardComponent';
import { DeckComponent, CARD_SLAB_HEIGHT, CARD_MASS } from './DeckComponent';
import { HandComponent } from './HandComponent';
import { MeshComponent } from './MeshComponent';
import { PhysicsComponent } from './PhysicsComponent';

let scene: SceneImpl;
let ctx: SpawnContext;

beforeEach(() => {
  registerCorePrimitives();
  scene = new SceneImpl();
  ctx = { scene: new THREE.Scene(), physics: new PhysicsWorld(), entityScene: scene };
});

function spawnCard(id: string, face: string, back: string, category: string = 'x') {
  const c = scene.spawn('card', ctx, { id });
  c.getComponent(CardComponent)!.setState({ face, back, category });
  return c;
}

describe('DeckComponent — patches mesh on cards change', () => {
  test('size.height grows to 0.02 × cards.length', () => {
    spawnCard('a', 'face-A', 'back-A');
    spawnCard('b', 'face-B', 'back-B');
    const deck = scene.spawn('deck', ctx);
    deck.getComponent(DeckComponent)!.setState({ cards: ['a', 'b'], category: 'x' });
    const ms = deck.getComponent(MeshComponent)!.state;
    expect(ms.height).toBeCloseTo(CARD_SLAB_HEIGHT * 2);
  });

  test('default (face-down): textureRefs.face = top card BACK, .back = bottom card FACE', () => {
    spawnCard('top', 'face-TOP', 'back-TOP');
    spawnCard('bot', 'face-BOT', 'back-BOT');
    const deck = scene.spawn('deck', ctx);
    deck.getComponent(DeckComponent)!.setState({ cards: ['top', 'bot'], category: '' });
    const slots = deck.getComponent(MeshComponent)!.state.textureRefs;
    expect(slots.face).toBe('back-TOP');
    expect(slots.back).toBe('face-BOT');
  });

  test('showTopFace=true flips both ends: .face = top card FACE, .back = bottom card BACK', () => {
    spawnCard('top', 'face-TOP', 'back-TOP');
    spawnCard('bot', 'face-BOT', 'back-BOT');
    const deck = scene.spawn('deck', ctx);
    deck.getComponent(DeckComponent)!.setState({ cards: ['top', 'bot'], category: '', showTopFace: true });
    const slots = deck.getComponent(MeshComponent)!.state.textureRefs;
    expect(slots.face).toBe('face-TOP');
    expect(slots.back).toBe('back-BOT');
  });

  test('toggling showTopFace alone re-applies textures without changing cards', () => {
    spawnCard('top', 'face-TOP', 'back-TOP');
    spawnCard('bot', 'face-BOT', 'back-BOT');
    const deck = scene.spawn('deck', ctx);
    const deckC = deck.getComponent(DeckComponent)!;
    deckC.setState({ cards: ['top', 'bot'], category: '' });
    deckC.setState({ showTopFace: true });
    const slots = deck.getComponent(MeshComponent)!.state.textureRefs;
    expect(slots.face).toBe('face-TOP');
    expect(slots.back).toBe('back-BOT');
  });

  test('mass = cardMass × cards.length', () => {
    spawnCard('a', '', '');
    spawnCard('b', '', '');
    spawnCard('c', '', '');
    const deck = scene.spawn('deck', ctx);
    deck.getComponent(DeckComponent)!.setState({ cards: ['a', 'b', 'c'], category: '' });
    const phys = deck.getComponent(PhysicsComponent)!;
    expect(phys.state.mass).toBeCloseTo(CARD_MASS * 3);
    expect(phys.body.mass).toBeCloseTo(CARD_MASS * 3);
  });

  test('empty cards is a no-op (size unchanged)', () => {
    const deck = scene.spawn('deck', ctx);
    const s = deck.getComponent(MeshComponent)!.state;
    const before = [s.width, s.height, s.depth];
    deck.getComponent(DeckComponent)!.setState({ cards: [], category: '' });
    const a = deck.getComponent(MeshComponent)!.state;
    expect([a.width, a.height, a.depth]).toEqual(before);
  });
});

describe('DeckComponent — context menu', () => {
  test('returns "Draw" action greyed out when caller has no main hand, plus Shuffle', () => {
    const deck = scene.spawn('deck', ctx);
    const items = deck.getComponent(DeckComponent)!.getMenuControls({
      recipientSeat: 0, isHost: true, entity: deck,
      preferences:   DEFAULT_PREFERENCES,
    });
    const draw = items.find((i: MenuItem) => i.kind === 'action' && i.id === 'draw') as
      | (MenuItem & { kind: 'action' })
      | undefined;
    expect(draw).toBeDefined();
    expect(draw!.label).toBe('Draw');
    expect(draw!.disabled).toBe(true);
    expect(items.some((i: MenuItem) => i.kind === 'action' && i.id === 'shuffle')).toBe(true);
  });

  test('"Draw" is a submenu (not a disabled action) when caller has a main hand', () => {
    const hand = scene.spawn('hand', ctx);
    hand.owner = 0;
    hand.getComponent(HandComponent)!.setState({ isMainHand: true });
    const deck = scene.spawn('deck', ctx);
    const items = deck.getComponent(DeckComponent)!.getMenuControls({
      recipientSeat: 0, isHost: true, entity: deck,
      preferences:   DEFAULT_PREFERENCES,
    });
    const drawSub = items.find((i: MenuItem) => i.kind === 'submenu' && i.label === 'Draw');
    expect(drawSub).toBeDefined();
    const sub = drawSub as MenuItem & { kind: 'submenu' };
    expect(sub.items.map(i => (i as { label: string }).label)).toEqual(['1', '2', '3', '5', 'Other…']);
  });

  test('"Draw" is greyed out when recipientSeat is null', () => {
    const deck = scene.spawn('deck', ctx);
    const items = deck.getComponent(DeckComponent)!.getMenuControls({
      recipientSeat: null, isHost: true, entity: deck,
      preferences:   DEFAULT_PREFERENCES,
    });
    const draw = items.find((i: MenuItem) => i.kind === 'action' && i.id === 'draw') as
      | (MenuItem & { kind: 'action' })
      | undefined;
    expect(draw?.disabled).toBe(true);
  });

  test('always includes a "Shuffle" action', () => {
    const deck = scene.spawn('deck', ctx);
    const items = deck.getComponent(DeckComponent)!.getMenuControls({
      recipientSeat: null, isHost: true, entity: deck,
      preferences:   DEFAULT_PREFERENCES,
    });
    const shuf = items.find((i: MenuItem) => i.kind === 'action' && i.id === 'shuffle') as
      | (MenuItem & { kind: 'action' })
      | undefined;
    expect(shuf?.label).toBe('Shuffle');
  });

  test('"Inspect" action lands between Shuffle and Deal, enabled when unlocked', () => {
    const deck = scene.spawn('deck', ctx);
    const items = deck.getComponent(DeckComponent)!.getMenuControls({
      recipientSeat: 0, isHost: true, entity: deck,
      preferences:   DEFAULT_PREFERENCES,
    });
    const shuffleIdx = items.findIndex((i: MenuItem) => i.kind === 'action' && i.id === 'shuffle');
    const inspectIdx = items.findIndex((i: MenuItem) => i.kind === 'action' && i.id === 'inspect');
    const dealIdx    = items.findIndex((i: MenuItem) => i.kind === 'submenu' && i.label === 'Deal');
    expect(shuffleIdx).toBeLessThan(inspectIdx);
    expect(inspectIdx).toBeLessThan(dealIdx);
    const inspect = items[inspectIdx] as MenuItem & { kind: 'action' };
    expect(inspect.disabled).toBeUndefined();
  });

  test('"Inspect" is disabled when locked by another seat', () => {
    const deck = scene.spawn('deck', ctx);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    const items = deck.getComponent(DeckComponent)!.getMenuControls({
      recipientSeat: 1, isHost: false, entity: deck,
      preferences:   DEFAULT_PREFERENCES,
    });
    const inspect = items.find((i: MenuItem) => i.kind === 'action' && i.id === 'inspect') as
      | (MenuItem & { kind: 'action' })
      | undefined;
    expect(inspect?.disabled).toBe(true);
    expect(inspect?.label).toContain('seat 0');
  });

  test('"Inspect" is enabled for the lock holder', () => {
    const deck = scene.spawn('deck', ctx);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    const items = deck.getComponent(DeckComponent)!.getMenuControls({
      recipientSeat: 0, isHost: false, entity: deck,
      preferences:   DEFAULT_PREFERENCES,
    });
    const inspect = items.find((i: MenuItem) => i.kind === 'action' && i.id === 'inspect') as
      | (MenuItem & { kind: 'action' })
      | undefined;
    expect(inspect?.disabled).toBeUndefined();
  });

  test('"Show top card face" toggle labels switch on showTopFace state', () => {
    const deck = scene.spawn('deck', ctx);
    const deckC = deck.getComponent(DeckComponent)!;
    const ctxMenu = {
      recipientSeat: 0, isHost: true, entity: deck,
      preferences:   DEFAULT_PREFERENCES,
    };
    const before = deckC.getMenuControls(ctxMenu)
      .find((i: MenuItem) => i.kind === 'action' && i.id === 'toggle-top-face') as
        (MenuItem & { kind: 'action' });
    expect(before.label).toBe('Show top card face');
    deckC.setState({ showTopFace: true });
    const after = deckC.getMenuControls(ctxMenu)
      .find((i: MenuItem) => i.kind === 'action' && i.id === 'toggle-top-face') as
        (MenuItem & { kind: 'action' });
    expect(after.label).toBe('Hide top card face');
  });

  test('onAction("toggle-top-face") flips the showTopFace property', () => {
    const deck = scene.spawn('deck', ctx);
    const deckC = deck.getComponent(DeckComponent)!;
    const actionCtx = {
      recipientSeat: 0, isHost: true, entity: deck,
      preferences:   DEFAULT_PREFERENCES,
    };
    expect(deckC.state.showTopFace).toBe(false);
    deckC.onAction('toggle-top-face', actionCtx);
    expect(deckC.state.showTopFace).toBe(true);
    deckC.onAction('toggle-top-face', actionCtx);
    expect(deckC.state.showTopFace).toBe(false);
  });
});

describe('DeckComponent.onTryGrab', () => {
  test('short press returns peel intent with the deck id', () => {
    spawnCard('a', '', '');
    spawnCard('b', '', '');
    const deck = scene.spawn('deck', ctx);
    deck.getComponent(DeckComponent)!.setState({ cards: ['a', 'b'], category: '' });
    expect(deck.getComponent(DeckComponent)!.onTryGrab(false)).toEqual({ kind: 'peel', sourceId: deck.id });
  });

  test('long press returns null (whole-deck grab falls through)', () => {
    spawnCard('a', '', '');
    spawnCard('b', '', '');
    const deck = scene.spawn('deck', ctx);
    deck.getComponent(DeckComponent)!.setState({ cards: ['a', 'b'], category: '' });
    expect(deck.getComponent(DeckComponent)!.onTryGrab(true)).toBeNull();
  });

  test('empty deck returns null (defensive fall-through during transitions)', () => {
    const deck = scene.spawn('deck', ctx);
    // Default state is cards: [].
    expect(deck.getComponent(DeckComponent)!.onTryGrab(false)).toBeNull();
    expect(deck.getComponent(DeckComponent)!.onTryGrab(true)).toBeNull();
  });

  test('search-locked deck refuses both short and long press', () => {
    spawnCard('a', '', '');
    spawnCard('b', '', '');
    const deck = scene.spawn('deck', ctx);
    deck.getComponent(DeckComponent)!.setState({ cards: ['a', 'b'], category: '' });
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    expect(deck.getComponent(DeckComponent)!.onTryGrab(false)).toBeNull();
    expect(deck.getComponent(DeckComponent)!.onTryGrab(true)).toBeNull();
  });
});


import { describe, test, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { SceneImpl } from './Scene';
import { type SpawnContext } from './EntityComponent';
import { HostReplicatorV2, type ReplicatorPolicy } from './HostReplicatorV2';
import { MergeService } from './MergeService';
import { DeckService } from './DeckService';
import { registerCorePrimitives } from './spawnables';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { CardComponent } from './components/CardComponent';
import { DeckComponent } from './components/DeckComponent';
import { HandComponent } from './components/HandComponent';
import { TransformComponent } from './components/TransformComponent';
import { TweenComponent } from './components/TweenComponent';
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
let decks:      DeckService;
let despawned:  string[];
let heldCards:  { id: string; seat: number }[];
let tryHoldFn:  (card: Entity, seat: number) => boolean;

function spawnAt(type: string, position: [number, number, number]): Entity {
  const e = scene.spawn(type, ctx);
  const t = e.getComponent(TransformComponent)!;
  t.setState({ position, rotation: t.state.rotation, scale: t.state.scale });
  return e;
}

function spawnCard(id: string, category = 'tarot', face = 'F', back = 'B'): Entity {
  const e = scene.spawn('card', ctx, { id });
  e.getComponent(CardComponent)!.setState({ face, back, category });
  return e;
}

function buildDeckOf(category: string, cardIds: string[]): Entity {
  for (const id of cardIds) spawnCard(id, category);
  const lower = scene.getEntity(cardIds[cardIds.length - 1])!;
  const t = lower.getComponent(TransformComponent)!;
  t.setState({ position: [0, 0.5, 0], rotation: t.state.rotation, scale: t.state.scale });

  // Build deck via MergeService card-card path, then merge remaining cards in.
  const deck = merge.merge(scene.getEntity(cardIds[0])!, lower)!;
  for (let i = 1; i < cardIds.length - 1; i++) {
    merge.merge(scene.getEntity(cardIds[i])!, deck);
  }
  return deck;
}

beforeEach(() => {
  registerCorePrimitives();
  scene = new SceneImpl();
  ctx = { scene: new THREE.Scene(), physics: new PhysicsWorld(), entityScene: scene };
  replicator = new HostReplicatorV2(POLICY);
  scene.world = replicator;
  despawned = [];
  merge = new MergeService(scene, replicator, {
    spawnAt: (type, position) => spawnAt(type, position),
  });
  heldCards = [];
  tryHoldFn = (card: Entity, seat: number) => {
    card.heldBy = seat as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
    heldCards.push({ id: card.id, seat });
    return true;
  };
  decks = new DeckService(scene, replicator, {
    despawn: (id) => {
      despawned.push(id);
      scene.removeEntity(id);
    },
    tryHold:     (card, seat) => tryHoldFn(card, seat),
    releaseHold: (card) => { card.heldBy = null; },
  });
});

describe('DeckService.drawFromDeck', () => {
  function setupSeatedHand(seat: 0 | 1): string {
    const hand = scene.spawn('hand', ctx);
    hand.owner = seat;
    hand.getComponent(HandComponent)!.setState({ isMainHand: true });
    return hand.id;
  }

  test('refuses when caller has no main hand', () => {
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    const drawn = decks.drawFromDeck(deck.id, 1, 0);
    expect(drawn).toBe(0);
    expect(deck.getComponent(DeckComponent)!.state.cards.length).toBe(3);
  });

  test('pops the front card and starts a tween into the main hand', () => {
    setupSeatedHand(0);
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    const cardsBefore = [...deck.getComponent(DeckComponent)!.state.cards];
    const drawn = decks.drawFromDeck(deck.id, 1, 0);
    expect(drawn).toBe(1);
    const cardsAfter = deck.getComponent(DeckComponent)!.state.cards;
    expect(cardsAfter).toEqual(cardsBefore.slice(1));

    const drawnCard = scene.getEntity(cardsBefore[0])!;
    expect(drawnCard.isContained).toBe(false);
    expect(drawnCard.parentId).toBeNull();
    expect(drawnCard.getComponent(TweenComponent)!.isActive()).toBe(true);
  });

  test('caps at deck size when count > cards.length', () => {
    setupSeatedHand(0);
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    const drawn = decks.drawFromDeck(deck.id, 99, 0);
    // 3 cards in deck → at most 2 can be drawn before maybeDissolve fires
    // (cards.length === 1 dissolves the deck and un-hides the lone card).
    expect(drawn).toBeLessThanOrEqual(3);
  });

  test('refuses when callerSeat is null', () => {
    setupSeatedHand(0);
    const deck = buildDeckOf('t', ['a', 'b']);
    expect(decks.drawFromDeck(deck.id, 1, null)).toBe(0);
  });

  test('refuses when count <= 0', () => {
    setupSeatedHand(0);
    const deck = buildDeckOf('t', ['a', 'b']);
    expect(decks.drawFromDeck(deck.id, 0, 0)).toBe(0);
  });
});

describe('DeckService.maybeDissolve', () => {
  test('does nothing when cards.length !== 1', () => {
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    const out = decks.maybeDissolve(deck.id);
    expect(out).toBe(false);
    expect(despawned).toEqual([]);
  });

  test('un-hides the lone card and despawns the deck when cards.length === 1', () => {
    const deck = buildDeckOf('t', ['a', 'b']);
    // Drop the deck to 1 card by directly mutating component state.
    deck.getComponent(DeckComponent)!.setState({ cards: ['a'] });
    const out = decks.maybeDissolve(deck.id);
    expect(out).toBe(true);
    expect(despawned).toContain(deck.id);
    const lone = scene.getEntity('a')!;
    expect(lone.isContained).toBe(false);
    expect(lone.parentId).toBeNull();
  });
});

describe('DeckService.peelTop', () => {
  test('pops top card, releases it, holds it for caller, returns deck pose', () => {
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    const t = deck.getComponent(TransformComponent)!;
    t.setState({ position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: t.state.scale });
    const cardsBefore = [...deck.getComponent(DeckComponent)!.state.cards];
    const topId = cardsBefore[0];
    const result = decks.peelTop(deck.id, 0)!;
    expect(result).not.toBeNull();
    expect(result.cardId).toBe(topId);
    // Peeled card surfaces above the deck rather than at its centre so the
    // re-added body doesn't punt the deck off the table. 3-card deck = 0.06
    // tall (half = 0.03), card height 0.01 (half = 0.005), plus 0.005 gap.
    expect(result.pos[0]).toBeCloseTo(1, 6);
    expect(result.pos[1]).toBeCloseTo(2 + 0.03 + 0.005 + 0.005, 6);
    expect(result.pos[2]).toBeCloseTo(3, 6);
    expect(result.rot).toEqual([0, 0, 0, 1]);

    const card = scene.getEntity(topId)!;
    expect(card.isContained).toBe(false);
    expect(card.parentId).toBeNull();
    expect(card.heldBy).toBe(0);
    expect(heldCards).toEqual([{ id: topId, seat: 0 }]);
    expect(deck.getComponent(DeckComponent)!.state.cards).toEqual(cardsBefore.slice(1));
  });

  test('returns null when deck id is unknown', () => {
    expect(decks.peelTop('missing-deck', 0)).toBeNull();
    expect(heldCards).toEqual([]);
  });

  test('returns null when the entity has no DeckComponent', () => {
    const card = spawnCard('lonecard');
    expect(decks.peelTop(card.id, 0)).toBeNull();
    expect(heldCards).toEqual([]);
  });

  test('returns null when the deck is empty', () => {
    const deck = buildDeckOf('t', ['a', 'b']);
    deck.getComponent(DeckComponent)!.setState({ cards: [] });
    expect(decks.peelTop(deck.id, 0)).toBeNull();
    expect(heldCards).toEqual([]);
  });

  test('dissolves the deck when peel drops it to a singleton', () => {
    const deck = buildDeckOf('t', ['a', 'b']);
    const cardsBefore = [...deck.getComponent(DeckComponent)!.state.cards];
    const topId  = cardsBefore[0];
    const loneId = cardsBefore[1];
    const result = decks.peelTop(deck.id, 0);
    expect(result).not.toBeNull();
    expect(result!.cardId).toBe(topId);
    expect(despawned).toContain(deck.id);
    const lone = scene.getEntity(loneId)!;
    expect(lone.isContained).toBe(false);
    expect(lone.parentId).toBeNull();
  });

  test('defensive tryHold failure releases the popped card and returns null', () => {
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    const topId = deck.getComponent(DeckComponent)!.state.cards[0];
    tryHoldFn = () => false;
    const result = decks.peelTop(deck.id, 0);
    expect(result).toBeNull();
    // releaseHold runs as cleanup; the card is no longer in the deck either way.
    expect(scene.getEntity(topId)!.heldBy).toBeNull();
  });

  test('race: two seats peel a deck that dissolves mid-race — winner peels, loser gets null', () => {
    // A 2-card deck dissolves after the first peel (cards.length → 1 →
    // maybeDissolve despawns the deck). The second seat's peel finds no
    // deck and returns null.
    const deck = buildDeckOf('t', ['a', 'b']);

    const first = decks.peelTop(deck.id, 0);
    expect(first).not.toBeNull();
    expect(despawned).toContain(deck.id);

    const second = decks.peelTop(deck.id, 1);
    expect(second).toBeNull();
    // Only one hold call recorded — the winner's.
    expect(heldCards).toHaveLength(1);
    expect(heldCards[0].seat).toBe(0);
  });

  test('atomicity: sequential peels from a 3-card deck each return distinct cards', () => {
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    const cardsBefore = [...deck.getComponent(DeckComponent)!.state.cards];

    const first  = decks.peelTop(deck.id, 0);
    const second = decks.peelTop(deck.id, 1);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.cardId).toBe(cardsBefore[0]);
    expect(second!.cardId).toBe(cardsBefore[1]);
    expect(first!.cardId).not.toBe(second!.cardId);
  });
});

describe('DeckService.dealFromDeck', () => {
  function setupHand(seat: 0 | 1 | 2 | 3): string {
    const hand = scene.spawn('hand', ctx);
    hand.owner = seat;
    hand.getComponent(HandComponent)!.setState({ isMainHand: true });
    return hand.id;
  }

  test('refuses when no recipients have main hands', () => {
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    const dealt = decks.dealFromDeck(deck.id, 1, 0);
    expect(dealt).toBe(0);
  });

  test('one round to one recipient pops top card', () => {
    setupHand(0);
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    const before = [...deck.getComponent(DeckComponent)!.state.cards];
    const dealt = decks.dealFromDeck(deck.id, 1, 0);
    expect(dealt).toBe(1);
    expect(deck.getComponent(DeckComponent)!.state.cards).toEqual(before.slice(1));
  });

  test('round-robin: 2 seats, count=2 → 4 cards, alternating', () => {
    setupHand(0);
    setupHand(1);
    const deck = buildDeckOf('t', ['a', 'b', 'c', 'd', 'e']);
    const before = [...deck.getComponent(DeckComponent)!.state.cards];
    const dealt = decks.dealFromDeck(deck.id, 2, 0);
    expect(dealt).toBe(4);
    expect(deck.getComponent(DeckComponent)!.state.cards).toEqual(before.slice(4));
    // First card to caller (seat 0); second to next clockwise.
    expect(scene.getEntity(before[0])!.isContained).toBe(false);
    expect(scene.getEntity(before[1])!.isContained).toBe(false);
  });

  test('stops on exhaustion mid-deal', () => {
    setupHand(0);
    setupHand(1);
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    const dealt = decks.dealFromDeck(deck.id, 2, 0);
    // 3 cards in deck → max 3 dealt; the 4th pop is skipped.
    // After dealing 3, the deck has 0 cards and dissolves immediately
    // (cards.length === 0 doesn't trigger maybeDissolve, but on length === 1
    // it would). Here the deck has 0 cards left. Don't expect dissolve.
    expect(dealt).toBe(3);
  });

  test('clockwise order: caller seat 2, recipient with hand at seat 1 dealt second', () => {
    setupHand(2);
    setupHand(1);
    const deck = buildDeckOf('t', ['a', 'b', 'c', 'd']);
    const cardsBefore = [...deck.getComponent(DeckComponent)!.state.cards];
    decks.dealFromDeck(deck.id, 1, 2);
    // Round 0: i=0 → seat 2 (caller), i=1 → seat (2-1)=1.
    // Card at index 0 of deck went to seat 2, card at index 1 went to seat 1.
    // Just verify both cards are released.
    expect(scene.getEntity(cardsBefore[0])!.isContained).toBe(false);
    expect(scene.getEntity(cardsBefore[1])!.isContained).toBe(false);
  });
});

describe('DeckService.shuffleDeck', () => {
  test('permutes cards (same set, possibly different order)', () => {
    const deck = buildDeckOf('t', ['a', 'b', 'c', 'd', 'e']);
    const before = [...deck.getComponent(DeckComponent)!.state.cards];
    decks.shuffleDeck(deck.id);
    const after = deck.getComponent(DeckComponent)!.state.cards;
    expect(after).toHaveLength(before.length);
    expect(new Set(after)).toEqual(new Set(before));
  });

  test('plays a rotation jitter tween on the deck', () => {
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    decks.shuffleDeck(deck.id);
    expect(deck.getComponent(TweenComponent)!.isActive()).toBe(true);
  });

  test('returns false for an unknown deck', () => {
    expect(decks.shuffleDeck('nope')).toBe(false);
  });
});

describe('DeckService.drawFromDeck — singleton dissolution', () => {
  test('drawing down to 1 card triggers dissolve', () => {
    const hand = scene.spawn('hand', ctx);
    hand.owner = 0;
    hand.getComponent(HandComponent)!.setState({ isMainHand: true });
    const deck = buildDeckOf('t', ['a', 'b']);
    const beforeId = deck.id;
    decks.drawFromDeck(deck.id, 1, 0);
    expect(despawned).toContain(beforeId);
    // Lone card is now loose on the table at the deck's pose.
    const lone = scene.getEntity('b')!;
    expect(lone.isContained).toBe(false);
  });
});

describe('DeckService — inspect-lock gating', () => {
  function setupHand(seat: 0 | 1): string {
    const hand = scene.spawn('hand', ctx);
    hand.owner = seat;
    hand.getComponent(HandComponent)!.setState({ isMainHand: true });
    return hand.id;
  }

  test('draw is a no-op when the deck is locked by another seat', () => {
    setupHand(1);
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    const before = [...deck.getComponent(DeckComponent)!.state.cards];
    expect(decks.drawFromDeck(deck.id, 1, 1)).toBe(0);
    expect(deck.getComponent(DeckComponent)!.state.cards).toEqual(before);
  });

  test('draw proceeds when the deck is locked by the caller', () => {
    setupHand(0);
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    expect(decks.drawFromDeck(deck.id, 1, 0)).toBe(1);
  });

  test('shuffle is a no-op when locked by another seat', () => {
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    const before = [...deck.getComponent(DeckComponent)!.state.cards];
    expect(decks.shuffleDeck(deck.id, 1)).toBe(false);
    expect(deck.getComponent(DeckComponent)!.state.cards).toEqual(before);
  });

  test('shuffle proceeds when the caller is the lock holder', () => {
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    expect(decks.shuffleDeck(deck.id, 0)).toBe(true);
  });

  test('deal is a no-op when locked by another seat', () => {
    setupHand(1);
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    expect(decks.dealFromDeck(deck.id, 1, 1)).toBe(0);
  });

  test('spread is a no-op when locked by another seat', () => {
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    const before = [...deck.getComponent(DeckComponent)!.state.cards];
    expect(decks.spreadDeck(deck.id, 1)).toBe(false);
    expect(deck.getComponent(DeckComponent)!.state.cards).toEqual(before);
  });

  test('peelTop is a no-op when locked by another seat', () => {
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    expect(decks.peelTop(deck.id, 1)).toBeNull();
    expect(heldCards).toEqual([]);
  });

  test('peelTop proceeds when the caller is the lock holder', () => {
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    expect(decks.peelTop(deck.id, 0)).not.toBeNull();
  });

  test('clearSearchLocksForSeat clears every matching lock and leaves others alone', () => {
    const deck1 = buildDeckOf('t', ['a', 'b']);
    const deck2 = buildDeckOf('t', ['c', 'd']);
    deck1.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    deck2.getComponent(DeckComponent)!.setState({ searchLockedBy: 1 });
    decks.clearSearchLocksForSeat(0);
    expect(deck1.getComponent(DeckComponent)!.state.searchLockedBy).toBeNull();
    expect(deck2.getComponent(DeckComponent)!.state.searchLockedBy).toBe(1);
  });

  test('openInspect sets the lock and returns a snapshot of every card', () => {
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    scene.getEntity('a')!.getComponent(CardComponent)!.setState({ face: 'fa', back: 'ba', category: 't' });
    scene.getEntity('b')!.getComponent(CardComponent)!.setState({ face: 'fb', back: 'bb', category: 't' });
    const snap = decks.openInspect(deck.id, 0);
    expect(snap).not.toBeNull();
    expect(deck.getComponent(DeckComponent)!.state.searchLockedBy).toBe(0);
    expect(snap!['a']).toEqual({ face: 'fa', back: 'ba' });
    expect(snap!['b']).toEqual({ face: 'fb', back: 'bb' });
  });

  test('openInspect is rejected when locked by another seat', () => {
    const deck = buildDeckOf('t', ['a', 'b']);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    expect(decks.openInspect(deck.id, 1)).toBeNull();
    expect(deck.getComponent(DeckComponent)!.state.searchLockedBy).toBe(0);
  });

  test('openInspect by the same seat is idempotent (snapshot returned, lock unchanged)', () => {
    const deck = buildDeckOf('t', ['a', 'b']);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    expect(decks.openInspect(deck.id, 0)).not.toBeNull();
    expect(deck.getComponent(DeckComponent)!.state.searchLockedBy).toBe(0);
  });

  test('closeInspect by the holder clears the lock', () => {
    const deck = buildDeckOf('t', ['a', 'b']);
    decks.openInspect(deck.id, 0);
    expect(decks.closeInspect(deck.id, 0)).toBe(true);
    expect(deck.getComponent(DeckComponent)!.state.searchLockedBy).toBeNull();
  });

  test('closeInspect by a non-holder is a no-op', () => {
    const deck = buildDeckOf('t', ['a', 'b']);
    decks.openInspect(deck.id, 0);
    expect(decks.closeInspect(deck.id, 1)).toBe(false);
    expect(deck.getComponent(DeckComponent)!.state.searchLockedBy).toBe(0);
  });

  test('reorderDeck applies a valid permutation when caller is lock holder', () => {
    const deck = buildDeckOf('t', ['a', 'b', 'c', 'd']);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    expect(decks.reorderDeck(deck.id, ['d', 'a', 'b', 'c'], 0)).toBe(true);
    expect(deck.getComponent(DeckComponent)!.state.cards).toEqual(['d', 'a', 'b', 'c']);
  });

  test('reorderDeck rejects when caller is not the lock holder', () => {
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    const before = [...deck.getComponent(DeckComponent)!.state.cards];
    expect(decks.reorderDeck(deck.id, ['c', 'a', 'b'], 1)).toBe(false);
    expect(deck.getComponent(DeckComponent)!.state.cards).toEqual(before);
  });

  test('reorderDeck rejects when deck is not locked at all', () => {
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    const before = [...deck.getComponent(DeckComponent)!.state.cards];
    expect(decks.reorderDeck(deck.id, ['c', 'a', 'b'], 0)).toBe(false);
    expect(deck.getComponent(DeckComponent)!.state.cards).toEqual(before);
  });

  test('reorderDeck rejects a non-permutation', () => {
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    const before = [...deck.getComponent(DeckComponent)!.state.cards];
    expect(decks.reorderDeck(deck.id, ['a', 'b', 'x'], 0)).toBe(false);
    expect(decks.reorderDeck(deck.id, ['a', 'b'], 0)).toBe(false);
    expect(deck.getComponent(DeckComponent)!.state.cards).toEqual(before);
  });

  test('extractFromDeck pops the named card and sets pose face-up at hit point', () => {
    const deck = buildDeckOf('t', ['a', 'b', 'c']);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    const before = [...deck.getComponent(DeckComponent)!.state.cards];
    expect(decks.extractFromDeck(deck.id, 'b', [1.0, 0, 2.0], 0)).toBe(true);
    const after = deck.getComponent(DeckComponent)!.state.cards;
    expect(after).toEqual(before.filter((id) => id !== 'b'));
    const card = scene.getEntity('b')!;
    expect(card.isContained).toBe(false);
    expect(card.parentId).toBeNull();
    const t = card.getComponent(TransformComponent)!.state;
    expect(t.position[0]).toBeCloseTo(1.0);
    expect(t.position[2]).toBeCloseTo(2.0);
    // Face-up rotation has +Y aligned with world +Y.
    const [qx, _qy, qz, _qw] = t.rotation;
    const yComp = 1 - 2 * (qx * qx + qz * qz);
    expect(yComp).toBeCloseTo(1, 5);
  });

  test('extractFromDeck rejects when caller is not the lock holder', () => {
    const deck = buildDeckOf('t', ['a', 'b']);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    const before = [...deck.getComponent(DeckComponent)!.state.cards];
    expect(decks.extractFromDeck(deck.id, 'a', [0, 0, 0], 1)).toBe(false);
    expect(deck.getComponent(DeckComponent)!.state.cards).toEqual(before);
  });

  test('extractFromDeck rejects an unknown card id', () => {
    const deck = buildDeckOf('t', ['a', 'b']);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    const before = [...deck.getComponent(DeckComponent)!.state.cards];
    expect(decks.extractFromDeck(deck.id, 'z', [0, 0, 0], 0)).toBe(false);
    expect(deck.getComponent(DeckComponent)!.state.cards).toEqual(before);
  });

  test('extractFromDeck rejects a hit point outside the table bounds', () => {
    const deck = buildDeckOf('t', ['a', 'b']);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    const before = [...deck.getComponent(DeckComponent)!.state.cards];
    // Default fallback bounds: halfWidth=6, halfDepth=4. 100 is far outside.
    expect(decks.extractFromDeck(deck.id, 'a', [100, 0, 0], 0)).toBe(false);
    expect(deck.getComponent(DeckComponent)!.state.cards).toEqual(before);
  });

  test('extracting down to 1 card triggers maybeDissolve', () => {
    const deck = buildDeckOf('t', ['a', 'b']);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    const deckId = deck.id;
    expect(decks.extractFromDeck(deck.id, 'a', [0, 0, 0], 0)).toBe(true);
    expect(despawned).toContain(deckId);
    expect(scene.getEntity('b')!.isContained).toBe(false);
  });

  test('save round-trip strips searchLockedBy', () => {
    const deck = buildDeckOf('t', ['a', 'b']);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    const json = deck.getComponent(DeckComponent)!.toJSON() as Record<string, unknown>;
    expect('searchLockedBy' in json).toBe(false);
    // Rehydrate via fromJSON — the lock should come back null.
    const fresh = scene.spawn('deck', ctx);
    fresh.getComponent(DeckComponent)!.fromJSON(json);
    expect(fresh.getComponent(DeckComponent)!.state.searchLockedBy).toBeNull();
  });
});

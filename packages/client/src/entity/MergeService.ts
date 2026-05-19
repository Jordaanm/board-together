// Host-only service that merges entities on contact.
// Issue #2 of issues--deck.md.
//
// `canMerge(a, b)` is the gating predicate (held / private-to-seat /
// already-contained / category-mismatch). `merge(a, b)` runs the actual
// transformation. The card↔card path spawns a new `deck` entity at the lower
// (lower-Y) card's pose, parents both cards under the deck with
// `isContained=true`, and orders the deck's `cards` with the upper card at
// index 0 (the visible top).
//
// The host wires beginContact on its physics world to call
// `tryMergeOnContact(a, b)` when two PhysicsComponent bodies first touch.

import { type Entity } from './Entity';
import { type SceneImpl } from './Scene';
import { type HostReplicatorV2 } from './HostReplicatorV2';
import { CardComponent } from './components/CardComponent';
import { DeckComponent } from './components/DeckComponent';
import { TransformComponent } from './components/TransformComponent';

// Max XZ-plane distance (in world units) between two entity centers for them
// to count as overlapping for merge purposes. Pure beginContact gating let
// edge-grazes form decks; this requires the centers to land close to each
// other before the merge fires.
export const MERGE_XZ_OVERLAP_THRESHOLD = 0.2;
export interface MergeHostFacade {
  // Spawns an entity of the given type at the supplied position; returns the
  // backing Entity (not a handle) so MergeService can patch component state
  // before any physics tick runs.
  spawnAt(type: string, position: [number, number, number]): Entity;
}

export class MergeService {
  // Pairs queued from beginContact, drained from `processQueued()` once the
  // physics step has fully integrated. Modifying the world's body list inside
  // the beginContact dispatch is unsafe — cannon-es is mid-iteration.
  private queued: Array<[string, string]> = [];

  // Live contact map fed by World's beginContact / endContact handlers.
  // Symmetric: both directions of every pair are recorded. Used by
  // `recheckMergeOverlaps` (HoldService.release path — issue #4) so a card
  // released into an existing contact still fires the merge even though
  // beginContact has long passed.
  private contacts = new Map<string, Set<string>>();

  constructor(
    private readonly scene:      SceneImpl,
    private readonly replicator: HostReplicatorV2,
    private readonly host:       MergeHostFacade,
  ) {}

  noteBeginContact(a: Entity, b: Entity): void {
    addContact(this.contacts, a.id, b.id);
  }

  noteEndContact(a: Entity, b: Entity): void {
    removeContact(this.contacts, a.id, b.id);
  }

  // Re-fires merge logic for any entity currently overlapping `entity`'s
  // physics body. Called by HoldService.release so a card released while
  // already touching a deck still merges. Issue #4 of issues--deck.md.
  recheckMergeOverlaps(entity: Entity): Entity | null {
    const set = this.contacts.get(entity.id);
    if (!set) return null;
    for (const otherId of [...set]) {
      const other = this.scene.getEntity(otherId);
      if (!other) continue;
      if (this.canMerge(entity, other)) {
        return this.merge(entity, other);
      }
    }
    return null;
  }

  // Host-only. Called by the World's beginContact handler. Defers the actual
  // merge work to the next `processQueued()` call.
  enqueueContact(a: Entity, b: Entity): void {
    if (!this.canMerge(a, b)) return;
    this.queued.push([a.id, b.id]);
  }

  // Drains the queue, running merges for any pairs still passing canMerge.
  // Called from World.tick() after physics.step(). Returns the number of
  // successful merges so callers can refresh derived state (e.g. notify
  // World subscribers that parentId/children just changed).
  processQueued(): number {
    if (this.queued.length === 0) return 0;
    const pairs = this.queued;
    this.queued = [];
    const merged = new Set<string>();
    let count = 0;
    for (const [aId, bId] of pairs) {
      if (merged.has(aId) || merged.has(bId)) continue;
      const a = this.scene.getEntity(aId);
      const b = this.scene.getEntity(bId);
      if (!a || !b) continue;
      const result = this.merge(a, b);
      if (result) {
        merged.add(aId);
        merged.add(bId);
        count++;
      }
    }
    return count;
  }

  canMerge(a: Entity, b: Entity): boolean {
    if (a === b) return false;
    if (a.heldBy !== null || b.heldBy !== null) return false;
    if (a.privateToSeat !== null || b.privateToSeat !== null) return false;
    if (a.isContained || b.isContained) return false;

    const aCard = a.getComponent(CardComponent);
    const bCard = b.getComponent(CardComponent);
    const aDeck = a.getComponent(DeckComponent);
    const bDeck = b.getComponent(DeckComponent);

    // Inspect-locked decks refuse incoming merges. The lock holder may extract
    // cards out via the Inspect dialog; physical collisions never absorb back
    // in until the lock clears. Issue #2 of planning/issues--deck-inspect.md.
    if (aDeck && aDeck.state.searchLockedBy !== null) return false;
    if (bDeck && bDeck.state.searchLockedBy !== null) return false;

    let categoryMatch = false;
    if (aCard && bCard)      categoryMatch = aCard.state.category === bCard.state.category;
    else if (aCard && bDeck) categoryMatch = aCard.state.category === bDeck.state.category;
    else if (aDeck && bCard) categoryMatch = bCard.state.category === aDeck.state.category;
    if (!categoryMatch) return false;

    return xzDistance(a, b) < MERGE_XZ_OVERLAP_THRESHOLD;
  }

  merge(a: Entity, b: Entity): Entity | null {
    if (!this.canMerge(a, b)) return null;
    const aCard = a.getComponent(CardComponent);
    const bCard = b.getComponent(CardComponent);
    const aDeck = a.getComponent(DeckComponent);
    const bDeck = b.getComponent(DeckComponent);
    if (aCard && bCard) {
      return this.mergeCardCard(a, b);
    }
    if (aCard && bDeck) {
      return this.mergeCardIntoDeck(a, b);
    }
    if (aDeck && bCard) {
      return this.mergeCardIntoDeck(b, a);
    }
    return null;
  }

  // Convenience entry point for tests / direct callers. Production host uses
  // enqueueContact + processQueued to keep mutations out of the physics step.
  tryMergeOnContact(a: Entity, b: Entity): Entity | null {
    return this.merge(a, b);
  }

  private mergeCardIntoDeck(card: Entity, deck: Entity): Entity {
    const deckC = deck.getComponent(DeckComponent)!;
    const cards = [card.id, ...deckC.state.cards];

    deck.children = [...cards];
    this.replicator.enqueueEntityPatch(deck.id, { children: [...cards] });

    deckC.setState({ cards });

    setEntityIsContained(card, true,    this.replicator);
    setEntityParentId   (card, deck.id, this.replicator);
    return deck;
  }

  private mergeCardCard(a: Entity, b: Entity): Entity {
    const aPos = a.getComponent(TransformComponent)!.state.position;
    const bPos = b.getComponent(TransformComponent)!.state.position;
    // Lower (lower-Y) becomes the bottom card; the other lands on top as the
    // newer arrival (index 0 of `cards`).
    const lower = aPos[1] <= bPos[1] ? a : b;
    const upper = aPos[1] <= bPos[1] ? b : a;
    const lowerPos = lower.getComponent(TransformComponent)!.state.position;
    const category = a.getComponent(CardComponent)!.state.category;
    return this.assembleDeckFrom(
      [upper, lower],
      [lowerPos[0], lowerPos[1], lowerPos[2]],
      category,
    );
  }

  // Spawns a fresh deck at `position` and parents the given cards into it
  // (index 0 = visible top). Mirrors the parent/child + isContained wiring of
  // mergeCardCard, but unconstrained by canMerge — callers (mergeCardCard,
  // World.generateDeck) are responsible for any gating. Returns the new deck.
  assembleDeckFrom(
    cards:    readonly Entity[],
    position: [number, number, number],
    category: string,
  ): Entity {
    const deck = this.host.spawnAt('deck', position);
    const cardIds = cards.map((c) => c.id);

    const name = category ? `Deck of ${category}` : `Deck-${deck.id.slice(0, 8)}`;
    deck.name = name;
    this.replicator.enqueueEntityPatch(deck.id, { name });

    deck.children = [...cardIds];
    this.replicator.enqueueEntityPatch(deck.id, { children: [...cardIds] });

    deck.getComponent(DeckComponent)!.setState({ cards: cardIds, category });

    for (const card of cards) {
      setEntityIsContained(card, true,    this.replicator);
      setEntityParentId   (card, deck.id, this.replicator);
    }

    return deck;
  }
}

function xzDistance(a: Entity, b: Entity): number {
  const aT = a.getComponent(TransformComponent);
  const bT = b.getComponent(TransformComponent);
  if (!aT || !bT) return Infinity;
  const dx = aT.state.position[0] - bT.state.position[0];
  const dz = aT.state.position[2] - bT.state.position[2];
  return Math.sqrt(dx * dx + dz * dz);
}

function addContact(map: Map<string, Set<string>>, a: string, b: string): void {
  let setA = map.get(a);
  if (!setA) { setA = new Set(); map.set(a, setA); }
  setA.add(b);
  let setB = map.get(b);
  if (!setB) { setB = new Set(); map.set(b, setB); }
  setB.add(a);
}

function removeContact(map: Map<string, Set<string>>, a: string, b: string): void {
  map.get(a)?.delete(b);
  map.get(b)?.delete(a);
}

function setEntityIsContained(entity: Entity, value: boolean, repl: HostReplicatorV2): void {
  if (entity.isContained === value) return;
  entity.isContained = value;
  for (const comp of entity.components.values()) comp.onIsContainedChanged(value);
  repl.enqueueEntityPatch(entity.id, { isContained: value });
}

function setEntityParentId(entity: Entity, parentId: string | null, repl: HostReplicatorV2): void {
  entity.parentId = parentId;
  repl.enqueueEntityPatch(entity.id, { parentId });
}

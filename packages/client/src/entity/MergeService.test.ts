import { describe, test, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { SceneImpl } from './Scene';
import { type SpawnContext } from './EntityComponent';
import { HostReplicatorV2, type ReplicatorPolicy } from './HostReplicatorV2';
import { MergeService, MERGE_XZ_OVERLAP_THRESHOLD } from './MergeService';
import { registerCorePrimitives } from './spawnables';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { CardComponent } from './components/CardComponent';
import { DeckComponent } from './components/DeckComponent';
import { BagComponent } from './components/BagComponent';
import { TransformComponent } from './components/TransformComponent';
import { type Entity } from './Entity';

const POLICY: ReplicatorPolicy = {
  channelFor:  () => 'reliable',
  coalesceFor: () => 'merge',
  shouldFlush: () => true,
};

let scene: SceneImpl;
let ctx: SpawnContext;
let replicator: HostReplicatorV2;
let merge: MergeService;

function spawnCard(opts: { id?: string; pos?: [number, number, number]; category?: string; face?: string; back?: string } = {}): Entity {
  const e = scene.spawn('card', ctx, { id: opts.id });
  const t = e.getComponent(TransformComponent)!;
  if (opts.pos) {
    t.setState({ position: opts.pos, rotation: t.state.rotation, scale: t.state.scale });
  }
  if (opts.category !== undefined || opts.face !== undefined || opts.back !== undefined) {
    e.getComponent(CardComponent)!.setState({
      category: opts.category ?? '',
      face:     opts.face     ?? '',
      back:     opts.back     ?? '',
    });
  }
  return e;
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
});

describe('MergeService.canMerge — gating', () => {
  test('two same-category, free, not-private, not-contained cards → true', () => {
    const a = spawnCard({ category: 'tarot' });
    const b = spawnCard({ category: 'tarot' });
    expect(merge.canMerge(a, b)).toBe(true);
  });

  test('mismatched category → false', () => {
    const a = spawnCard({ category: 'tarot' });
    const b = spawnCard({ category: 'pinochle' });
    expect(merge.canMerge(a, b)).toBe(false);
  });

  test('held card → false', () => {
    const a = spawnCard({ category: 'x' });
    const b = spawnCard({ category: 'x' });
    a.heldBy = 1;
    expect(merge.canMerge(a, b)).toBe(false);
  });

  test('privateToSeat (in hand) → false', () => {
    const a = spawnCard({ category: 'x' });
    const b = spawnCard({ category: 'x' });
    a.privateToSeat = 0;
    expect(merge.canMerge(a, b)).toBe(false);
  });

  test('isContained (already in deck) → false', () => {
    const a = spawnCard({ category: 'x' });
    const b = spawnCard({ category: 'x' });
    a.isContained = true;
    expect(merge.canMerge(a, b)).toBe(false);
  });

  test('same entity → false', () => {
    const a = spawnCard({ category: 'x' });
    expect(merge.canMerge(a, a)).toBe(false);
  });

  test('non-card vs card → false', () => {
    const a = spawnCard({ category: 'x' });
    const die = scene.spawn('die', ctx);
    expect(merge.canMerge(a, die)).toBe(false);
  });

  test('XZ centers outside overlap threshold → false', () => {
    const a = spawnCard({ pos: [0,     0.5, 0], category: 'x' });
    const b = spawnCard({ pos: [10000, 0.7, 0], category: 'x' });
    expect(merge.canMerge(a, b)).toBe(false);
  });

  test('XZ centers within overlap threshold → true', () => {
    const offset = MERGE_XZ_OVERLAP_THRESHOLD / 2;
    const a = spawnCard({ pos: [0,      0.5, 0],      category: 'x' });
    const b = spawnCard({ pos: [offset, 0.7, offset], category: 'x' });
    expect(merge.canMerge(a, b)).toBe(true);
  });

  test('Y difference alone does not block merge (XZ only)', () => {
    const a = spawnCard({ pos: [0, 0,    0], category: 'x' });
    const b = spawnCard({ pos: [0, 1000, 0], category: 'x' });
    expect(merge.canMerge(a, b)).toBe(true);
  });
});

describe('MergeService.merge — card↔card', () => {
  test('spawns a deck at the lower card pose with newer card at index 0', () => {
    const lower = spawnCard({ id: 'lo', pos: [0, 0.5, 0], category: 'tarot', face: 'fL', back: 'bL' });
    const upper = spawnCard({ id: 'up', pos: [0, 0.7, 0], category: 'tarot', face: 'fU', back: 'bU' });

    const deck = merge.merge(upper, lower);
    expect(deck).not.toBeNull();
    const deckC = deck!.getComponent(DeckComponent)!;
    expect(deckC.state.cards).toEqual(['up', 'lo']);
    expect(deckC.state.category).toBe('tarot');

    const deckPos = deck!.getComponent(TransformComponent)!.state.position;
    expect(deckPos).toEqual([0, 0.5, 0]);
  });

  test('order is independent of argument order', () => {
    const lower = spawnCard({ id: 'lo', pos: [0, 0.5, 0], category: 'x' });
    const upper = spawnCard({ id: 'up', pos: [0, 0.7, 0], category: 'x' });
    const deck = merge.merge(lower, upper);
    expect(deck!.getComponent(DeckComponent)!.state.cards).toEqual(['up', 'lo']);
  });

  test('sets isContained=true and parentId=deck.id on both cards', () => {
    const a = spawnCard({ id: 'a', pos: [0, 0.5, 0], category: 'x' });
    const b = spawnCard({ id: 'b', pos: [0, 0.7, 0], category: 'x' });
    const deck = merge.merge(a, b);
    expect(a.isContained).toBe(true);
    expect(b.isContained).toBe(true);
    expect(a.parentId).toBe(deck!.id);
    expect(b.parentId).toBe(deck!.id);
  });

  test('deck name is "Deck of {category}" when category set', () => {
    const a = spawnCard({ pos: [0, 0.5, 0], category: 'tarot' });
    const b = spawnCard({ pos: [0, 0.7, 0], category: 'tarot' });
    const deck = merge.merge(a, b);
    expect(deck!.name).toBe('Deck of tarot');
  });

  test('deck name is "Deck-{guid8}" when category empty', () => {
    const a = spawnCard({ pos: [0, 0.5, 0], category: '' });
    const b = spawnCard({ pos: [0, 0.7, 0], category: '' });
    const deck = merge.merge(a, b);
    expect(deck!.name).toMatch(/^Deck-[0-9a-fA-F]{8}$/);
  });

  test('refuses when canMerge returns false', () => {
    const a = spawnCard({ category: 'x' });
    const b = spawnCard({ category: 'y' });
    expect(merge.merge(a, b)).toBeNull();
  });

  test('replicates the new isContained, parentId, name, children fields', () => {
    const lower = spawnCard({ id: 'lo', pos: [0, 0.5, 0], category: 't' });
    const upper = spawnCard({ id: 'up', pos: [0, 0.7, 0], category: 't' });
    const deck = merge.merge(upper, lower)!;

    const reliable = replicator.flushReliable();
    const patches: Array<{ entityId: string; partial: Record<string, unknown> }> = [];
    for (const m of reliable) {
      if (m.type === 'entity-patch') patches.push({ entityId: m.entityId, partial: m.partial });
    }
    // Cards' isContained=true must have been enqueued.
    expect(patches.some(p => p.entityId === 'up' && p.partial.isContained === true)).toBe(true);
    expect(patches.some(p => p.entityId === 'lo' && p.partial.isContained === true)).toBe(true);
    // Cards' parentId must point at the new deck.
    expect(patches.some(p => p.entityId === 'up' && p.partial.parentId === deck.id)).toBe(true);
    expect(patches.some(p => p.entityId === 'lo' && p.partial.parentId === deck.id)).toBe(true);
  });
});

describe('MergeService — queued contact processing', () => {
  test('enqueueContact + processQueued runs the merge', () => {
    const a = spawnCard({ id: 'a', pos: [0, 0.5, 0], category: 'x' });
    const b = spawnCard({ id: 'b', pos: [0, 0.7, 0], category: 'x' });
    merge.enqueueContact(a, b);
    merge.processQueued();
    expect(a.isContained).toBe(true);
    expect(b.isContained).toBe(true);
  });

  test('enqueueContact filters via canMerge before queueing', () => {
    const a = spawnCard({ category: 'x' });
    const b = spawnCard({ category: 'y' });
    merge.enqueueContact(a, b);
    merge.processQueued();
    expect(a.isContained).toBe(false);
    expect(b.isContained).toBe(false);
  });

  test('a card already merged in an earlier pair is skipped in later pairs', () => {
    const a = spawnCard({ id: 'a', pos: [0, 0.5, 0], category: 'x' });
    const b = spawnCard({ id: 'b', pos: [0, 0.7, 0], category: 'x' });
    const c = spawnCard({ id: 'c', pos: [0, 0.6, 0], category: 'x' });
    merge.enqueueContact(a, b);
    merge.enqueueContact(b, c);  // b is already merged after first pair
    merge.processQueued();
    expect(a.isContained).toBe(true);
    expect(b.isContained).toBe(true);
    // c is still loose (no card↔deck merge until issue #3).
    expect(c.isContained).toBe(false);
  });
});

describe('MergeService.merge — card↔deck', () => {
  function spawnDeckWith(deckPos: [number, number, number], cards: string[], category: string) {
    const deck = scene.spawn('deck', ctx);
    const t = deck.getComponent(TransformComponent)!;
    t.setState({ position: deckPos, rotation: t.state.rotation, scale: t.state.scale });
    deck.getComponent(DeckComponent)!.setState({ cards, category });
    deck.children = [...cards];
    return deck;
  }

  test('card joins deck at index 0; deck transform unchanged', () => {
    const c1 = spawnCard({ id: 'c1', category: 'tarot', face: 'f1', back: 'b1' });
    const c2 = spawnCard({ id: 'c2', category: 'tarot', face: 'f2', back: 'b2' });
    // Pre-merge into a deck.
    const deck = merge.merge(c1, c2)!;
    const deckPosBefore = [...deck.getComponent(TransformComponent)!.state.position] as [number, number, number];

    // New card lands.
    const newer = spawnCard({ id: 'newer', pos: [0, 1, 0], category: 'tarot', face: 'fNEW', back: 'bNEW' });
    const result = merge.merge(newer, deck);
    expect(result).toBe(deck);

    const deckC = deck.getComponent(DeckComponent)!;
    expect(deckC.state.cards[0]).toBe('newer');
    expect(deckC.state.cards.length).toBe(3);

    const deckPosAfter = deck.getComponent(TransformComponent)!.state.position;
    expect(deckPosAfter).toEqual(deckPosBefore);
  });

  test('mismatched-category card vs deck → no merge', () => {
    const c1 = spawnCard({ category: 'tarot' });
    const c2 = spawnCard({ category: 'tarot' });
    const deck = merge.merge(c1, c2)!;
    const odd = spawnCard({ category: 'pinochle' });
    expect(merge.merge(odd, deck)).toBeNull();
    expect(merge.canMerge(odd, deck)).toBe(false);
  });

  test('argument order is symmetric', () => {
    const c1 = spawnCard({ category: 'x' });
    const c2 = spawnCard({ category: 'x' });
    const deck = merge.merge(c1, c2)!;
    const newer = spawnCard({ id: 'n', category: 'x' });
    const result = merge.merge(deck, newer);  // deck first
    expect(result).toBe(deck);
    expect(deck.getComponent(DeckComponent)!.state.cards[0]).toBe('n');
  });

  test('held card cannot merge with a deck', () => {
    const c1 = spawnCard({ category: 'x' });
    const c2 = spawnCard({ category: 'x' });
    const deck = merge.merge(c1, c2)!;
    const newer = spawnCard({ category: 'x' });
    newer.heldBy = 0;
    expect(merge.canMerge(newer, deck)).toBe(false);
  });

  test('held deck cannot merge with a card', () => {
    const c1 = spawnCard({ category: 'x' });
    const c2 = spawnCard({ category: 'x' });
    const deck = merge.merge(c1, c2)!;
    deck.heldBy = 0;
    const newer = spawnCard({ category: 'x' });
    expect(merge.canMerge(newer, deck)).toBe(false);
  });

  test('card colliding with a search-locked deck is not absorbed', () => {
    const c1 = spawnCard({ category: 'x' });
    const c2 = spawnCard({ category: 'x' });
    const deck = merge.merge(c1, c2)!;
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    const newer = spawnCard({ category: 'x' });
    expect(merge.canMerge(newer, deck)).toBe(false);
    expect(merge.merge(newer, deck)).toBeNull();
  });

  test('same card absorbs into the same deck once the lock clears', () => {
    const c1 = spawnCard({ category: 'x' });
    const c2 = spawnCard({ category: 'x' });
    const deck = merge.merge(c1, c2)!;
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: 0 });
    const newer = spawnCard({ category: 'x' });
    expect(merge.canMerge(newer, deck)).toBe(false);
    deck.getComponent(DeckComponent)!.setState({ searchLockedBy: null });
    expect(merge.canMerge(newer, deck)).toBe(true);
  });
});

describe('MergeService.recheckMergeOverlaps', () => {
  test('merges with a contacted entity that passes canMerge', () => {
    const a = spawnCard({ id: 'a', pos: [0, 0.5, 0], category: 'x' });
    const b = spawnCard({ id: 'b', pos: [0, 0.7, 0], category: 'x' });
    merge.noteBeginContact(a, b);
    // Held cards never trigger merge; simulate held-then-released by toggling.
    a.heldBy = 0;
    expect(merge.recheckMergeOverlaps(a)).toBeNull();
    a.heldBy = null;
    const result = merge.recheckMergeOverlaps(a);
    expect(result).not.toBeNull();
    expect(a.isContained).toBe(true);
    expect(b.isContained).toBe(true);
  });

  test('skips a contact whose entity has been despawned', () => {
    const a = spawnCard({ id: 'a', category: 'x' });
    const b = spawnCard({ id: 'b', category: 'x' });
    merge.noteBeginContact(a, b);
    scene.removeEntity('b');
    expect(merge.recheckMergeOverlaps(a)).toBeNull();
  });

  test('ignores contacts past their endContact', () => {
    const a = spawnCard({ id: 'a', category: 'x' });
    const b = spawnCard({ id: 'b', category: 'x' });
    merge.noteBeginContact(a, b);
    merge.noteEndContact(a, b);
    expect(merge.recheckMergeOverlaps(a)).toBeNull();
  });

  test('no-op when entity has no contacts', () => {
    const a = spawnCard({ id: 'a', category: 'x' });
    expect(merge.recheckMergeOverlaps(a)).toBeNull();
  });
});

describe('MergeService — bag absorb (issue #2 of issues--bag.md)', () => {
  test('releasing a held die over a bag absorbs it (contents, parentId, isContained)', () => {
    const bag = scene.spawn('bag', ctx, { id: 'bag' });
    const die = scene.spawn('die', ctx, { id: 'die' });
    merge.noteBeginContact(die, bag);
    // Recheck after release: heldBy is null, contacts include bag.
    const result = merge.recheckMergeOverlaps(die);
    expect(result).toBe(bag);
    expect(bag.getComponent(BagComponent)!.state.contents).toEqual(['die']);
    expect(die.parentId).toBe('bag');
    expect(die.isContained).toBe(true);
    expect(bag.children).toContain('die');
  });

  test('free-floating physics contact (no recheck) does NOT absorb', () => {
    const bag = scene.spawn('bag', ctx);
    const die = scene.spawn('die', ctx);
    merge.noteBeginContact(die, bag);
    // Simulate the beginContact-only path (issue #2 says: free-floating
    // contacts go through enqueueContact + canMerge, which has no bag rule).
    merge.enqueueContact(die, bag);
    merge.processQueued();
    expect(die.isContained).toBe(false);
    expect(bag.getComponent(BagComponent)!.state.contents).toEqual([]);
  });

  test('releasing a held bag onto one of its own descendants is refused', () => {
    const outer = scene.spawn('bag', ctx, { id: 'outer' });
    const inner = scene.spawn('bag', ctx, { id: 'inner' });
    inner.parentId = 'outer';
    outer.children = ['inner'];
    outer.getComponent(BagComponent)!.state.contents = ['inner'];
    // Try to drop outer onto inner — would create a cycle.
    merge.noteBeginContact(outer, inner);
    const result = merge.recheckMergeOverlaps(outer);
    expect(result).toBeNull();
    expect(outer.isContained).toBe(false);
    expect(outer.parentId).toBeNull();
  });

  test('acceptComponents filter rejection leaves both entities untouched', () => {
    const bag = scene.spawn('bag', ctx);
    const die = scene.spawn('die', ctx);
    bag.getComponent(BagComponent)!.state.acceptComponents = ['card'];
    merge.noteBeginContact(die, bag);
    expect(merge.recheckMergeOverlaps(die)).toBeNull();
    expect(die.isContained).toBe(false);
    expect(bag.getComponent(BagComponent)!.state.contents).toEqual([]);
  });

  test('hand-zone entity dropped over a bag is refused (Zone exclusion)', () => {
    const bag = scene.spawn('bag', ctx);
    const hand = scene.spawn('hand', ctx);
    merge.noteBeginContact(hand, bag);
    expect(merge.recheckMergeOverlaps(hand)).toBeNull();
    expect(hand.isContained).toBe(false);
  });

  test('snap-marker dropped over a bag is refused (zone-style exclusion)', () => {
    const bag = scene.spawn('bag', ctx);
    const snap = scene.spawn('snap-marker', ctx);
    merge.noteBeginContact(snap, bag);
    expect(merge.recheckMergeOverlaps(snap)).toBeNull();
    expect(snap.isContained).toBe(false);
  });

  test('releasing a held deck over a bag absorbs the deck intact', () => {
    // Make a deck via card+card merge first.
    const c1 = spawnCard({ id: 'c1', pos: [0, 0.5, 0], category: 't' });
    const c2 = spawnCard({ id: 'c2', pos: [0, 0.7, 0], category: 't' });
    const deck = merge.merge(c1, c2)!;
    const bag = scene.spawn('bag', ctx, { id: 'bag' });

    merge.noteBeginContact(deck, bag);
    const result = merge.recheckMergeOverlaps(deck);
    expect(result).toBe(bag);
    // Deck is in the bag's contents.
    expect(bag.getComponent(BagComponent)!.state.contents).toEqual([deck.id]);
    expect(deck.parentId).toBe('bag');
    expect(deck.isContained).toBe(true);
    // Deck's own cards remain contained inside the deck, not the bag.
    expect(deck.getComponent(DeckComponent)!.state.cards.sort()).toEqual(['c1', 'c2']);
    expect(c1.parentId).toBe(deck.id);
    expect(c2.parentId).toBe(deck.id);
  });

  test('releasing a held bag over another bag absorbs the inner bag whole', () => {
    const outer = scene.spawn('bag', ctx, { id: 'outer' });
    const inner = scene.spawn('bag', ctx, { id: 'inner' });
    merge.noteBeginContact(inner, outer);
    const result = merge.recheckMergeOverlaps(inner);
    expect(result).toBe(outer);
    expect(outer.getComponent(BagComponent)!.state.contents).toEqual(['inner']);
    expect(inner.parentId).toBe('outer');
    expect(inner.isContained).toBe(true);
  });

  test('emits an entity-patch + component-patch pair for the absorb', () => {
    const bag = scene.spawn('bag', ctx, { id: 'bag' });
    const die = scene.spawn('die', ctx, { id: 'die' });
    replicator.flushReliable();  // clear prior patches from setup.
    merge.noteBeginContact(die, bag);
    merge.recheckMergeOverlaps(die);

    const reliable = replicator.flushReliable();
    const entityPatches: Array<{ entityId: string; partial: Record<string, unknown> }> = [];
    const componentPatches: Array<{ entityId: string; typeId: string; partial: Record<string, unknown> }> = [];
    for (const m of reliable) {
      if (m.type === 'entity-patch') {
        entityPatches.push({ entityId: m.entityId, partial: m.partial });
      } else if (m.type === 'component-patches') {
        for (const p of m.patches) {
          componentPatches.push({ entityId: p.entityId, typeId: p.typeId, partial: p.partial });
        }
      }
    }
    expect(entityPatches.some(p => p.entityId === 'die' && p.partial.isContained === true)).toBe(true);
    expect(entityPatches.some(p => p.entityId === 'die' && p.partial.parentId === 'bag')).toBe(true);
    expect(componentPatches.some(p =>
      p.entityId === 'bag' && p.typeId === 'bag' &&
      Array.isArray(p.partial.contents) && (p.partial.contents as string[]).includes('die')
    )).toBe(true);
  });
});

describe('MergeService — public spawnable filter', () => {
  test('deck spawnable is registered as internal', async () => {
    const { getSpawnable, listPublicSpawnables } = await import('./SpawnableRegistry');
    const def = getSpawnable('deck');
    expect(def?.internal).toBe(true);
    expect(listPublicSpawnables().some(d => d.type === 'deck')).toBe(false);
  });
});

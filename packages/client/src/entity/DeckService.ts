// Host-only operations on Decks. Issue #6 of issues--deck.md (Draw +
// singleton dissolve). Issue #7 (Shuffle) and #9 (Deal) extend it.
//
// Each verb here mutates host state, fires through the replicator, and
// triggers any required tweens. Authority gating (canManipulate / has-main-hand)
// happens at the call site (HostInputDispatcher / dispatchMenuAction) before
// reaching this service.

import * as THREE from 'three';
import { type SceneImpl } from './Scene';
import { type Entity } from './Entity';
import { type SeatIndex } from '../seats/SeatLayout';
import { type HostReplicatorV2 } from './HostReplicatorV2';
import { type PeelAndHoldResult } from './wire';
import { DeckComponent } from './components/DeckComponent';
import { CardComponent } from './components/CardComponent';
import { TransformComponent } from './components/TransformComponent';
import { TweenComponent } from './components/TweenComponent';
import { PhysicsComponent } from './components/PhysicsComponent';
import { MeshComponent } from './components/MeshComponent';
import { HandComponent } from './components/HandComponent';
import { isLockedAgainst } from './components/deckLock';

export interface DeckHostFacade {
  despawn(entityId: string): void;
  // Synchronous hold-claim for the freshly-peeled card. Delegates to the
  // host's HoldService.tryClaim. Returns true on success.
  tryHold(card: Entity, seat: SeatIndex): boolean;
  // Defensive cleanup if tryHold somehow fails after the card has been
  // released from the deck (shouldn't happen in practice).
  releaseHold(card: Entity): void;
}

const TWEEN_INTO_HAND_MS = 250;
const SHUFFLE_JITTER_MS  = 200;
// Y-axis rotation magnitude for the shuffle jitter (radians). ~10 degrees.
const SHUFFLE_JITTER_RAD = 0.18;
// Per-card stagger between scheduled deal tweens (ms).
const DEAL_STAGGER_MS    = 80;
// Per-card stagger between scheduled spread tweens (ms). Default for
// `spreadDeck`; callers can pass a different value.
export const SPREAD_STAGGER_MS_DEFAULT = 1000;
// Total seat count — matches SeatLayout.SeatIndex range. Used by the
// clockwise walk so we don't need to import SeatLayout here.
const SEAT_COUNT         = 8;

export class DeckService {
  constructor(
    private readonly scene:      SceneImpl,
    private readonly replicator: HostReplicatorV2,
    private readonly host:       DeckHostFacade,
  ) {}

  // Open Inspect on a deck. Issue #3 of planning/issues--deck-inspect.md.
  // Sets `searchLockedBy = seat` and returns a snapshot of every card's
  // face/back textures so the dialog can render thumbnails (cards inside a
  // deck have their privacy-sensitive fields scrubbed on the wire). Returns
  // `null` and leaves the lock untouched when the deck is unknown, lacks
  // DeckComponent, or is already locked by another seat — caller inspects
  // `searchLockedBy` for the rejection reason.
  openInspect(deckId: string, seat: SeatIndex): Record<string, { face: string; back: string }> | null {
    const deck = this.scene.getEntity(deckId);
    if (!deck) return null;
    const deckC = deck.getComponent(DeckComponent);
    if (!deckC) return null;
    if (isLockedAgainst(deckC.state, seat)) return null;
    deckC.setState({ searchLockedBy: seat });
    const snapshot: Record<string, { face: string; back: string }> = {};
    for (const cardId of deckC.state.cards) {
      const card  = this.scene.getEntity(cardId);
      const cardC = card?.getComponent(CardComponent);
      if (!cardC) continue;
      snapshot[cardId] = { face: cardC.state.face, back: cardC.state.back };
    }
    return snapshot;
  }

  // Close Inspect on a deck. Clears the lock iff `seat` matches the current
  // `searchLockedBy`; non-holder close is a no-op. Returns true when the lock
  // was cleared.
  closeInspect(deckId: string, seat: SeatIndex): boolean {
    const deck = this.scene.getEntity(deckId);
    if (!deck) return false;
    const deckC = deck.getComponent(DeckComponent);
    if (!deckC) return false;
    if (deckC.state.searchLockedBy !== seat) return false;
    deckC.setState({ searchLockedBy: null });
    return true;
  }

  // Disconnect cleanup. Walks every deck and clears any `searchLockedBy` that
  // matches `seat`. Issue #2 of planning/issues--deck-inspect.md. Idempotent;
  // safe to call when no decks hold the seat's lock.
  clearSearchLocksForSeat(seat: SeatIndex): void {
    for (const e of this.scene.all()) {
      const deckC = e.getComponent(DeckComponent);
      if (!deckC) continue;
      if (deckC.state.searchLockedBy !== seat) continue;
      deckC.setState({ searchLockedBy: null });
    }
  }

  // Pops `min(count, deck.cards.length)` cards from the front of the deck and
  // tweens each into the caller's main hand. After the loop, `maybeDissolve`
  // checks whether the deck has shrunk to a singleton and, if so, un-hides the
  // lone card and despawns the deck. Returns the number of cards drawn.
  drawFromDeck(deckId: string, count: number, callerSeat: SeatIndex | null): number {
    if (count <= 0 || callerSeat === null) return 0;
    const deck = this.scene.getEntity(deckId);
    if (!deck) return 0;
    const deckC = deck.getComponent(DeckComponent);
    if (!deckC) return 0;
    if (isLockedAgainst(deckC.state, callerSeat)) return 0;

    const handId = mainHandIdFor(this.scene, callerSeat);
    if (!handId) return 0;
    const hand = this.scene.getEntity(handId);
    if (!hand) return 0;

    const popN = Math.min(count, deckC.state.cards.length);
    if (popN === 0) return 0;

    const popped = deckC.state.cards.slice(0, popN);
    const remaining = deckC.state.cards.slice(popN);
    deckC.setState({ cards: remaining });

    const deckTransform = deck.getComponent(TransformComponent)!;
    const deckPos = deckTransform.state.position;
    const deckRot = deckTransform.state.rotation;
    const handTransform = hand.getComponent(TransformComponent);
    const handPos = handTransform?.state.position ?? deckPos;

    for (const cardId of popped) {
      const card = this.scene.getEntity(cardId);
      if (!card) continue;
      this.releaseCardFromDeck(card, deckPos, deckRot);
      // Tween to the hand's centre. The hand's zone beginContact then runs
      // the existing slot-arrange / privacy-set flow.
      const tween = card.getComponent(TweenComponent);
      if (tween) {
        tween.tweenTo({ position: [handPos[0], handPos[1], handPos[2]] }, TWEEN_INTO_HAND_MS);
      }
    }

    this.maybeDissolve(deckId);
    return popN;
  }

  // Fisher-Yates shuffle on the deck's `cards`, plus a brief rotation jitter
  // tween for visual feedback. Issue #7 of issues--deck.md.
  shuffleDeck(deckId: string, callerSeat: SeatIndex | null = null): boolean {
    const deck = this.scene.getEntity(deckId);
    if (!deck) return false;
    const deckC = deck.getComponent(DeckComponent);
    if (!deckC) return false;
    if (isLockedAgainst(deckC.state, callerSeat)) return false;
    if (deckC.state.cards.length < 2) {
      // Nothing meaningful to shuffle; still play the jitter for parity.
      this.playShuffleJitter(deck);
      return true;
    }
    const shuffled = fisherYates([...deckC.state.cards]);
    deckC.setState({ cards: shuffled });
    this.playShuffleJitter(deck);
    return true;
  }

  private playShuffleJitter(deck: Entity): void {
    const transform = deck.getComponent(TransformComponent);
    const tween     = deck.getComponent(TweenComponent);
    if (!transform || !tween) return;
    const [qx, qy, qz, qw] = transform.state.rotation;
    const cur = new THREE.Quaternion(qx, qy, qz, qw);
    const dq  = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), SHUFFLE_JITTER_RAD);
    const target = cur.clone().multiply(dq);
    const pos = transform.state.position;
    tween.tweenTo({
      position: [pos[0], pos[1], pos[2]],
      rotation: [target.x, target.y, target.z, target.w],
    }, SHUFFLE_JITTER_MS);
  }

  // Deal `count` cards round-robin to every seat with a main hand, ordered
  // clockwise from the caller (caller first). Per-card tween is the standard
  // 250ms; cards are scheduled with an 80ms stagger via TweenComponent's
  // delay support. Stops when the deck runs out mid-deal. Returns total
  // cards dealt. Issue #9 of issues--deck.md.
  dealFromDeck(deckId: string, count: number, callerSeat: SeatIndex | null): number {
    if (count <= 0 || callerSeat === null) return 0;
    const deck = this.scene.getEntity(deckId);
    if (!deck) return 0;
    const deckC = deck.getComponent(DeckComponent);
    if (!deckC) return 0;
    if (isLockedAgainst(deckC.state, callerSeat)) return 0;

    const recipients = clockwiseSeatsWithMainHand(this.scene, callerSeat);
    if (recipients.length === 0) return 0;

    const deckTransform = deck.getComponent(TransformComponent)!;
    const deckPos = deckTransform.state.position;
    const deckRot = deckTransform.state.rotation;

    let dealt = 0;
    const newCards = [...deckC.state.cards];
    outer: for (let round = 0; round < count; round++) {
      for (let i = 0; i < recipients.length; i++) {
        if (newCards.length === 0) break outer;
        const cardId = newCards.shift()!;
        const card = this.scene.getEntity(cardId);
        if (!card) continue;
        const seat = recipients[i];
        const handId = mainHandIdFor(this.scene, seat);
        if (!handId) continue;
        const hand = this.scene.getEntity(handId);
        const handPos = hand?.getComponent(TransformComponent)?.state.position ?? deckPos;

        this.releaseCardFromDeck(card, deckPos, deckRot);
        const tween = card.getComponent(TweenComponent);
        if (tween) {
          const delay = (round * recipients.length + i) * DEAL_STAGGER_MS;
          tween.tweenTo(
            { position: [handPos[0], handPos[1], handPos[2]] },
            TWEEN_INTO_HAND_MS,
            delay,
          );
        }
        dealt++;
      }
    }

    deckC.setState({ cards: newCards });
    this.maybeDissolve(deckId);
    return dealt;
  }

  // Spread the deck across the table: release every card in `cards` order,
  // tween each into a row extending along the deck's local +X axis (starting
  // one card-width away so the first card doesn't overlap the deck), then
  // despawn the now-empty deck. Index 0 (the top card) lands closest to the
  // deck; subsequent cards extend outward. `staggerMs` is the delay between
  // each card's tween start.
  spreadDeck(
    deckId:    string,
    callerSeat: SeatIndex | null = null,
    staggerMs:  number = SPREAD_STAGGER_MS_DEFAULT,
  ): boolean {
    const deck = this.scene.getEntity(deckId);
    if (!deck) return false;
    const deckC = deck.getComponent(DeckComponent);
    if (!deckC) return false;
    if (isLockedAgainst(deckC.state, callerSeat)) return false;
    const cards = [...deckC.state.cards];
    if (cards.length === 0) return false;

    const transform = deck.getComponent(TransformComponent)!;
    const deckPos = transform.state.position;
    const deckRot = transform.state.rotation;

    // Edge-to-edge spacing: card centers exactly one card-width apart. Well
    // above MergeService's xz-overlap threshold (0.2), so adjacent cards
    // won't merge back into a deck on contact.
    const mesh = deck.getComponent(MeshComponent);
    const spacing = mesh?.state.width ?? 0.63;

    const q = new THREE.Quaternion(deckRot[0], deckRot[1], deckRot[2], deckRot[3]);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);

    // Clear deck.cards first so the deck mesh stops rendering its slab on
    // the next replicator flush. The deck entity is despawned below.
    deckC.setState({ cards: [] });

    const n = cards.length;
    for (let i = 0; i < n; i++) {
      const card = this.scene.getEntity(cards[i]);
      if (!card) continue;
      // First card sits one card-width from the deck so it doesn't overlap;
      // each subsequent card sits a further card-width along.
      const offset = (i + 1) * spacing;
      const targetPos: [number, number, number] = [
        deckPos[0] + right.x * offset,
        deckPos[1],
        deckPos[2] + right.z * offset,
      ];
      this.releaseCardFromDeck(card, targetPos, deckRot);
      const phys = card.getComponent(PhysicsComponent);
      if (phys?.body) {
        phys.body.velocity.setZero();
        phys.body.angularVelocity.setZero();
      }
    }

    this.host.despawn(deckId);
    return true;
  }

  // Short-press peel — atomic pop, release, hold, dissolve. Issue #2 of
  // issues--deck-peel.md. Returns the new card's id and pose, or null if the
  // deck is unknown, missing DeckComponent, empty, or the hold fails
  // defensively. Caller is expected to have already gated `canManipulate`.
  peelTop(deckId: string, callerSeat: SeatIndex): PeelAndHoldResult | null {
    const deck = this.scene.getEntity(deckId);
    if (!deck) return null;
    const deckC = deck.getComponent(DeckComponent);
    if (!deckC) return null;
    if (isLockedAgainst(deckC.state, callerSeat)) return null;
    if (deckC.state.cards.length === 0) return null;

    const cardId = deckC.state.cards[0];
    const card = this.scene.getEntity(cardId);
    if (!card) return null;

    const deckTransform = deck.getComponent(TransformComponent);
    if (!deckTransform) return null;
    const rot: [number, number, number, number] = [
      deckTransform.state.rotation[0],
      deckTransform.state.rotation[1],
      deckTransform.state.rotation[2],
      deckTransform.state.rotation[3],
    ];

    // Surface the peeled card just above the deck top, in the deck's local
    // +Y direction. Without this lift the card body re-enters the world
    // co-located with the deck body; the kinematic-hold that follows then
    // resolves the overlap by punting the deck across the table.
    const deckMesh  = deck.getComponent(MeshComponent);
    const cardMesh  = card.getComponent(MeshComponent);
    const deckHalfH = (deckMesh?.state.height ?? 0) * 0.5;
    const cardHalfH = (cardMesh?.state.height ?? 0) * 0.5;
    const LIFT_GAP  = 0.005;
    const lift      = deckHalfH + cardHalfH + LIFT_GAP;
    const upWorld   = new THREE.Vector3(0, 1, 0)
      .applyQuaternion(new THREE.Quaternion(rot[0], rot[1], rot[2], rot[3]));
    const pos: [number, number, number] = [
      deckTransform.state.position[0] + upWorld.x * lift,
      deckTransform.state.position[1] + upWorld.y * lift,
      deckTransform.state.position[2] + upWorld.z * lift,
    ];

    // Pop first so a concurrent guest call doesn't see the same top card.
    // Single-threaded JS means this is genuinely atomic from any concurrent
    // RPC's perspective.
    deckC.setState({ cards: deckC.state.cards.slice(1) });
    this.releaseCardFromDeck(card, pos, rot);

    if (!this.host.tryHold(card, callerSeat)) {
      // Defensive — card just left contained state with heldBy=null, so
      // tryClaim should always succeed. If it doesn't, release any partial
      // hold and bail without dissolving.
      this.host.releaseHold(card);
      return null;
    }

    this.maybeDissolve(deckId);
    return { cardId, pos, rot };
  }

  // If the deck has exactly 1 card left, un-hide that card at the deck's
  // current pose with zero velocity, then despawn the deck. No-op otherwise.
  maybeDissolve(deckId: string): boolean {
    const deck = this.scene.getEntity(deckId);
    if (!deck) return false;
    const deckC = deck.getComponent(DeckComponent);
    if (!deckC) return false;
    if (deckC.state.cards.length !== 1) return false;

    const loneId = deckC.state.cards[0];
    const lone = this.scene.getEntity(loneId);
    if (!lone) {
      // Card already gone — drop the deck as a defensive cleanup.
      this.host.despawn(deckId);
      return true;
    }

    const deckTransform = deck.getComponent(TransformComponent)!;
    this.releaseCardFromDeck(lone, deckTransform.state.position, deckTransform.state.rotation);
    const phys = lone.getComponent(PhysicsComponent);
    if (phys?.body) {
      phys.body.velocity.setZero();
      phys.body.angularVelocity.setZero();
    }

    this.host.despawn(deckId);
    return true;
  }

  // Shared between draw and dissolve: clears isContained / parentId, snaps
  // transform to the deck's pose, then re-emits face/back so the privacy
  // scrubber recomputes audience now that parentId is null.
  private releaseCardFromDeck(
    card:    Entity,
    pos:     readonly [number, number, number],
    rot:     readonly [number, number, number, number],
  ): void {
    if (card.isContained) {
      card.isContained = false;
      for (const comp of card.components.values()) comp.onIsContainedChanged(false);
      this.replicator.enqueueEntityPatch(card.id, { isContained: false });
    }
    if (card.parentId !== null) {
      const parent = this.scene.getEntity(card.parentId);
      if (parent) {
        // Without this, despawning the deck cascade-despawns the released
        // card because Scene.cascadeDespawn walks parent.children.
        parent.children = parent.children.filter((c) => c !== card.id);
        this.replicator.enqueueEntityPatch(parent.id, { children: [...parent.children] });
      }
      card.parentId = null;
      this.replicator.enqueueEntityPatch(card.id, { parentId: null });
    }
    const transform = card.getComponent(TransformComponent);
    if (transform) {
      transform.setState({
        position: [pos[0], pos[1], pos[2]],
        rotation: [rot[0], rot[1], rot[2], rot[3]],
        scale:    transform.state.scale,
      });
    }
    const phys = card.getComponent(PhysicsComponent);
    if (phys?.body) {
      phys.body.position.set(pos[0], pos[1], pos[2]);
      phys.body.quaternion.set(rot[0], rot[1], rot[2], rot[3]);
    }
    const cardC = card.getComponent(CardComponent);
    if (cardC) {
      // Re-emit face/back so peers receive real values now that the deck-
      // privacy rule no longer applies.
      cardC.setState({ face: cardC.state.face, back: cardC.state.back });
    }
  }
}

function fisherYates<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Walks every seat with a main hand, ordered clockwise from `callerSeat`
// (caller first). Returns the seat indices in deal order. Seat numbering
// in `SeatLayout` walks counter-clockwise as the index increases, so the
// clockwise traversal subtracts.
function clockwiseSeatsWithMainHand(scene: SceneImpl, callerSeat: SeatIndex): SeatIndex[] {
  const seatsWithHand = new Set<SeatIndex>();
  for (const e of scene.all()) {
    if (e.owner === null) continue;
    const hand = e.getComponent(HandComponent);
    if (hand?.state.isMainHand) seatsWithHand.add(e.owner);
  }
  const out: SeatIndex[] = [];
  for (let i = 0; i < SEAT_COUNT; i++) {
    const seat = ((callerSeat - i + SEAT_COUNT) % SEAT_COUNT) as SeatIndex;
    if (seatsWithHand.has(seat)) out.push(seat);
  }
  return out;
}

// Returns the entity id of the seat's main hand, or null if none exists.
export function mainHandIdFor(scene: SceneImpl, seat: SeatIndex): string | null {
  for (const e of scene.all()) {
    if (e.owner !== seat) continue;
    const hand = e.getComponent(HandComponent);
    if (hand?.state.isMainHand) return e.id;
  }
  return null;
}

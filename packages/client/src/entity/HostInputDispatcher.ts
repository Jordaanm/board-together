// Host-side handler for inbound guest messages on the scene channel.
// Slice #6 of planning/issues/issues--scene-graph.md — pulls the validation
// logic out of ThreeCanvas so OwnershipPolicy + HoldService coordination is
// independently testable.
//
// Responsibility split:
//   * GuestInputHandler  — guest-drag-move position streams (no policy gate;
//                          gating happens through entity.heldBy ownership).
//   * HostInputDispatcher — scene-channel RPCs (hold-claim / hold-release /
//                          request-update) that do gate on OwnershipPolicy.

import { type SceneImpl } from './Scene';
import { type Entity } from './Entity';
import { type SeatIndex } from '../seats/SeatLayout';
import { canManipulate } from '../seats/OwnershipPolicy';
import { type HoldService } from './HoldService';
import { type DeckService } from './DeckService';
import { type SceneHistoryService } from './SceneHistoryService';
import { type HoldClaim, type HoldRelease, type InvokeAction, type RequestUpdate, type ApplyImpulse, type PlayCardToTable, type ReorderHand, type TweenIntoHand, type DrawFromDeck, type ShuffleDeck, type DealFromDeck, type SpreadDeck, type PeelAndHoldRequest, type PeelAndHoldResult } from './wire';
import { type ActionContext } from './EntityComponent';
import { load as loadPreferences } from '../preferences/storage';
import { PhysicsComponent } from './components/PhysicsComponent';
import { TweenComponent } from './components/TweenComponent';
import { ZoneComponent } from './components/ZoneComponent';
import { HandComponent } from './components/HandComponent';
import { DeckComponent } from './components/DeckComponent';
import { TransformComponent } from './components/TransformComponent';
import { isLockedAgainst } from './components/deckLock';

const PLAY_TO_TABLE_TWEEN_MS = 250;
const TWEEN_INTO_HAND_MS     = 250;

export class HostInputDispatcher {
  private decks: DeckService | null = null;
  private history: SceneHistoryService | null = null;

  constructor(
    private readonly hold:        HoldService,
    private readonly getPeerSeat: (peerId: string) => SeatIndex | null,
    private readonly scene:       SceneImpl,
  ) {}

  // World wires this on host construction. Tests omit it; the draw-from-deck
  // path is rejected when null.
  setDeckService(deck: DeckService): void {
    this.decks = deck;
  }

  // World wires this on host construction. Guest-initiated host mutators push
  // a snapshot label here so undo / History sees the mutation alongside host-
  // local actions. Tests omit it.
  setHistoryService(history: SceneHistoryService): void {
    this.history = history;
  }

  private push(label: string): void {
    this.history?.push(label);
  }

  // Returns true on accept (entity claimed and broadcast). False on any
  // refusal: unknown entity, ownership refused, already held.
  handleHoldClaim(_peerId: string, msg: HoldClaim): boolean {
    const entity = this.scene.getEntity(msg.entityId);
    if (!entity) return false;
    if (!canManipulate({ peerSeat: msg.seat, isHost: false }, entity.owner)) return false;
    if (deckLockedAgainst(entity, msg.seat)) return false;
    return this.hold.tryClaim(entity, msg.seat);
  }

  handleHoldRelease(peerId: string, msg: HoldRelease): boolean {
    const entity = this.scene.getEntity(msg.entityId);
    if (!entity) return false;
    const senderSeat = this.getPeerSeat(peerId);
    if (senderSeat === null || entity.heldBy !== senderSeat) return false;
    const vel = (msg.vx !== undefined || msg.vy !== undefined || msg.vz !== undefined)
      ? { vx: msg.vx ?? 0, vy: msg.vy ?? 0, vz: msg.vz ?? 0 }
      : undefined;
    this.push(`drop ${entity.name}`);
    this.hold.release(entity, vel);
    return true;
  }

  handleRequestUpdate(peerId: string, msg: RequestUpdate): boolean {
    const entity = this.scene.getEntity(msg.entityId);
    if (!entity) return false;
    const senderSeat = this.getPeerSeat(peerId);
    if (!canManipulate({ peerSeat: senderSeat, isHost: false }, entity.owner)) return false;
    const comp = entity.components.get(msg.typeId);
    if (!comp) return false;
    comp.setState(msg.partial);
    return true;
  }

  // Guest-fired action (menu click or hotkey). Host validates ownership,
  // looks up the targeted component, snapshots the host's local preferences
  // (so guest-originated dispatches see consistent values), runs
  // `onAction(name, ctx)` on it.
  handleInvokeAction(peerId: string, msg: InvokeAction): boolean {
    const entity = this.scene.getEntity(msg.entityId);
    if (!entity) return false;
    const senderSeat = this.getPeerSeat(peerId);
    if (!canManipulate({ peerSeat: senderSeat, isHost: false }, entity.owner)) return false;
    const comp = entity.components.get(msg.componentTypeId);
    if (!comp) return false;
    const ctx: ActionContext = {
      recipientSeat: senderSeat,
      isHost:        false,
      entity,
      preferences:   loadPreferences(),
    };
    comp.onAction(msg.actionId, ctx);
    return true;
  }

  // Issue #5a of issues--tools.md — guest's FlickTool fires an impulse.
  // Host re-validates `canManipulate` + `!isLocked` before applying.
  handleApplyImpulse(peerId: string, msg: ApplyImpulse): boolean {
    const entity = this.scene.getEntity(msg.entityId);
    if (!entity) return false;
    const senderSeat = this.getPeerSeat(peerId);
    if (!canManipulate({ peerSeat: senderSeat, isHost: false }, entity.owner)) return false;
    const phys = entity.getComponent(PhysicsComponent);
    if (!phys) return false;
    if (phys.state.isLocked) return false;
    phys.applyImpulse({ x: msg.vx, y: msg.vy, z: msg.vz });
    return true;
  }

  // Issue #5 of issues--hand.md — guest drags a tile out of the hand panel
  // onto the canvas. Sender's seat must own the containing hand (or the hand
  // is shared / null-owner) and the entity must have a TweenComponent.
  handlePlayCardToTable(peerId: string, msg: PlayCardToTable): boolean {
    const senderSeat = this.getPeerSeat(peerId);
    if (senderSeat === null) return false;
    const entity = this.scene.getEntity(msg.entityId);
    if (!entity) return false;
    const hand = findContainingHand(this.scene, entity.id);
    if (!hand) return false;
    if (hand.owner !== null && hand.owner !== senderSeat) return false;
    const tween = entity.getComponent(TweenComponent);
    if (!tween) return false;
    this.push(`play ${entity.name}`);
    tween.tweenTo({ position: [msg.x, msg.y, msg.z] }, PLAY_TO_TABLE_TWEEN_MS);
    return true;
  }

  // Issue #6 of issues--hand.md — guest drags a tile within the hand panel
  // to reorder the hand. HandComponent.reorderContents validates the
  // permutation and re-arranges 3D slots; replication carries the new order
  // to all peers.
  handleReorderHand(peerId: string, msg: ReorderHand): boolean {
    const senderSeat = this.getPeerSeat(peerId);
    if (senderSeat === null) return false;
    const hand = this.scene.getEntity(msg.handEntityId);
    if (!hand) return false;
    if (hand.owner !== null && hand.owner !== senderSeat) return false;
    const handComp = hand.getComponent(HandComponent);
    if (!handComp) return false;
    this.push(`reorder ${hand.name}`);
    return handComp.reorderContents(msg.newOrder);
  }

  // Issue #6 of issues--deck.md — guest right-clicks Draw on a deck. Host
  // validates ownership, then runs the draw via DeckService.
  handleDrawFromDeck(peerId: string, msg: DrawFromDeck): boolean {
    if (!this.decks) return false;
    const senderSeat = this.getPeerSeat(peerId);
    if (senderSeat === null) return false;
    const entity = this.scene.getEntity(msg.deckId);
    if (!entity) return false;
    if (!canManipulate({ peerSeat: senderSeat, isHost: false }, entity.owner)) return false;
    if (deckLockedAgainst(entity, senderSeat)) return false;
    this.push(`draw ${msg.count} from ${entity.name}`);
    const drawn = this.decks.drawFromDeck(msg.deckId, msg.count, senderSeat);
    return drawn > 0;
  }

  // Issue #7 of issues--deck.md — guest right-clicks Shuffle on a deck.
  handleShuffleDeck(peerId: string, msg: ShuffleDeck): boolean {
    if (!this.decks) return false;
    const senderSeat = this.getPeerSeat(peerId);
    if (senderSeat === null) return false;
    const entity = this.scene.getEntity(msg.deckId);
    if (!entity) return false;
    if (!canManipulate({ peerSeat: senderSeat, isHost: false }, entity.owner)) return false;
    if (deckLockedAgainst(entity, senderSeat)) return false;
    this.push(`shuffle ${entity.name}`);
    return this.decks.shuffleDeck(msg.deckId, senderSeat);
  }

  // Issue #9 of issues--deck.md — guest right-clicks "Deal N" on a deck.
  handleDealFromDeck(peerId: string, msg: DealFromDeck): boolean {
    if (!this.decks) return false;
    const senderSeat = this.getPeerSeat(peerId);
    if (senderSeat === null) return false;
    const entity = this.scene.getEntity(msg.deckId);
    if (!entity) return false;
    if (!canManipulate({ peerSeat: senderSeat, isHost: false }, entity.owner)) return false;
    if (deckLockedAgainst(entity, senderSeat)) return false;
    this.push(`deal ${msg.count} from ${entity.name}`);
    const dealt = this.decks.dealFromDeck(msg.deckId, msg.count, senderSeat);
    return dealt > 0;
  }

  // Issue #2 of issues--deck-peel.md — guest short-press-peels the top card
  // off a deck. Validates ownership + seat, delegates the atomic pop /
  // release / hold sequence to DeckService.peelTop, returns the new card's
  // id and pose (or null on any rejection). World.handleInboundHost wraps
  // the result in a `peel-and-hold-reply` to the requesting peer.
  handlePeelAndHold(peerId: string, msg: PeelAndHoldRequest): PeelAndHoldResult | null {
    if (!this.decks) return null;
    const senderSeat = this.getPeerSeat(peerId);
    if (senderSeat === null) return null;
    const entity = this.scene.getEntity(msg.deckId);
    if (!entity) return null;
    if (!canManipulate({ peerSeat: senderSeat, isHost: false }, entity.owner)) return null;
    if (deckLockedAgainst(entity, senderSeat)) return null;
    const result = this.decks.peelTop(msg.deckId, senderSeat);
    if (result) this.push(`peel ${entity.name}`);
    return result;
  }

  // Guest right-clicks "Spread deck" on a deck. Host validates ownership and
  // runs the spread via DeckService.
  handleSpreadDeck(peerId: string, msg: SpreadDeck): boolean {
    if (!this.decks) return false;
    const senderSeat = this.getPeerSeat(peerId);
    if (senderSeat === null) return false;
    const entity = this.scene.getEntity(msg.deckId);
    if (!entity) return false;
    if (!canManipulate({ peerSeat: senderSeat, isHost: false }, entity.owner)) return false;
    if (deckLockedAgainst(entity, senderSeat)) return false;
    this.push(`spread ${entity.name}`);
    return this.decks.spreadDeck(msg.deckId, senderSeat);
  }

  // Issue #7 of issues--hand.md — guest releases a 3D-grabbed entity over
  // the hand panel. Host tweens the entity to the hand's centre; the zone's
  // beginContact then triggers HandComponent's slot logic. Sender's seat
  // must own the destination hand (or it's null-owner / shared).
  handleTweenIntoHand(peerId: string, msg: TweenIntoHand): boolean {
    const senderSeat = this.getPeerSeat(peerId);
    if (senderSeat === null) return false;
    const hand = this.scene.getEntity(msg.handEntityId);
    if (!hand) return false;
    if (hand.owner !== null && hand.owner !== senderSeat) return false;
    const entity = this.scene.getEntity(msg.entityId);
    if (!entity) return false;
    const tween = entity.getComponent(TweenComponent);
    if (!tween) return false;
    const handPose = hand.getComponent(TransformComponent)?.state.position;
    if (!handPose) return false;
    this.push(`pick up ${entity.name}`);
    tween.tweenTo({ position: [handPose[0], handPose[1], handPose[2]] }, TWEEN_INTO_HAND_MS);
    return true;
  }
}

// Returns true when the entity carries a DeckComponent whose inspect lock is
// held against `seat`. Cheap to call on entities that may or may not be decks
// — non-decks return false.
function deckLockedAgainst(entity: Entity, seat: SeatIndex | null): boolean {
  const deckC = entity.getComponent(DeckComponent);
  if (!deckC) return false;
  return isLockedAgainst(deckC.state, seat);
}

// Walks every Hand entity and returns the one whose zone currently contains
// `cardId`. Returns null if the card is not in any hand. Linear scan; fine
// for PoC scale.
export function findContainingHand(scene: SceneImpl, cardId: string): Entity | null {
  for (const e of scene.all()) {
    if (!e.getComponent(HandComponent)) continue;
    const zone = e.getComponent(ZoneComponent);
    if (zone?.state.containedIds.includes(cardId)) return e;
  }
  return null;
}

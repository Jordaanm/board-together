// Card-game hand semantics, composing ZoneComponent + TweenComponent.
//
// Issue #3 of planning/issues--hand.md. Subscribes to its sibling zone's
// enter/exit, marks contents private to the hand's owner, and re-arranges
// every contained card into a fan-style slot along the hand's local +X axis
// via per-card tweens. Host-only logic — guests just observe the replicated
// `containedIds` and `privateToSeat` mutations.

import * as THREE from 'three';
import {
  EntityComponent,
  type SpawnContext,
  type ActionContext,
  type ActionDefinition,
} from '../EntityComponent';
import { type PropertyDef } from '../propertySchema';
import { type Entity } from '../Entity';
import { type SeatIndex } from '../../seats/SeatLayout';
import { TransformComponent } from './TransformComponent';
import { ZoneComponent } from './ZoneComponent';
import { TweenComponent } from './TweenComponent';
import { CardComponent } from './CardComponent';
import { FlatViewComponent } from './FlatViewComponent';
import { isPermutation } from '../util/isPermutation';

export interface HandState {
  isMainHand: boolean;
  isPrivate:  boolean;
}

// Card-width along the layout axis. Default playing-card has X size 0.63;
// this is the upper bound on slot spacing — past it the hand spreads no
// further and instead overlaps fan-style.
const ONE_CARD_WIDTH = 0.63;

// Sub-mm Y lift per slot index so later cards render on top of earlier ones
// when fan-overlapping.
const SLOT_LIFT_PER_INDEX = 0.002;

// Default tween duration for hand re-arrangement (ms).
const ARRANGE_TWEEN_MS = 250;

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

export class HandComponent extends EntityComponent<HandState> {
  static typeId   = 'hand';
  static label    = 'Hand';
  static requires = ['zone'] as const;
  // Hand state covers the seat-tagging and privacy flags. The half-extents
  // and debug-box visibility live on the sibling ZoneComponent and surface
  // automatically through Zone's own propertySchema section. The isMainHand
  // toggle only makes sense once an owner is assigned, so it's gated by a
  // condition predicate over the entity's owner.
  static propertySchema: readonly PropertyDef<HandState>[] = [
    {
      key:       'isMainHand',
      label:     'Main hand',
      type:      'boolean',
      condition: (_state, entity) => entity.owner !== null,
    },
    { key: 'isPrivate', label: 'Private', type: 'boolean' },
  ];

  private unsubscribeEnter: (() => void) | null = null;
  private unsubscribeExit:  (() => void) | null = null;

  onSpawn(_ctx: SpawnContext): void {
    const zone = this.entity.getComponent(ZoneComponent);
    if (!zone) return;
    this.unsubscribeEnter = zone.subscribeEnter(e => this.handleEnter(e));
    this.unsubscribeExit  = zone.subscribeExit (e => this.handleExit(e));
  }

  onDespawn(_ctx: SpawnContext): void {
    this.unsubscribeEnter?.();
    this.unsubscribeExit?.();
    this.unsubscribeEnter = null;
    this.unsubscribeExit  = null;
  }

  onPropertiesChanged(changed: Partial<HandState>): void {
    // Host-only: enforce one-main-hand-per-seat. setState has already merged
    // before this hook fires, so `state.isMainHand === true` is the new value.
    if (changed.isMainHand === true && this.world) {
      this.clearSiblingMainHandFlags();
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────
  // Reorder the contained cards. `newOrder` must be a permutation of the
  // current `containedIds` — anything else is rejected. Mutates the zone's
  // ordered membership and re-arranges 3D slots to match. Returns true on
  // success. Issue #6 of issues--hand.md.
  reorderContents(newOrder: readonly string[]): boolean {
    const zone = this.entity.getComponent(ZoneComponent);
    if (!zone) return false;
    const current = zone.state.containedIds;
    if (!isPermutation(current, newOrder)) return false;
    if (sameArrayOrder(current, newOrder)) return false;
    zone.setState({ containedIds: [...newOrder] });
    this.arrangeContents();
    return true;
  }

  // Re-tween every current content into its computed slot pose. Wired to the
  // "Tidy hand" context-menu action and called whenever membership changes.
  arrangeContents(): void {
    const zone = this.entity.getComponent(ZoneComponent);
    if (!zone) return;
    const ids   = zone.state.containedIds;
    const poses = this.computeSlotPoses(zone, ids.length);
    for (let i = 0; i < ids.length; i++) {
      const target = this.entity.scene?.getEntity(ids[i]);
      if (!target) continue;
      const tween = target.getComponent(TweenComponent);
      if (!tween) continue;
      tween.tweenTo(poses[i], ARRANGE_TWEEN_MS);
    }
  }

  // ── Context menu ───────────────────────────────────────────────────────
  getActions(_ctx: ActionContext): ActionDefinition[] {
    return [{ name: 'tidy-hand', label: 'Tidy hand' }];
  }

  onAction(name: string, _ctx: ActionContext): void {
    if (name === 'tidy-hand') this.arrangeContents();
  }

  // ── Zone subscription handlers (host-only) ────────────────────────────
  private handleEnter(entity: Entity): void {
    if (!this.world) return;
    if (this.state.isPrivate) {
      this.setEntityPrivateToSeat(entity, this.entity.owner);
      // Re-emit privacy-sensitive fields so the PrivacyScrubber blanks them
      // on the wire to non-owner peers (issue #8). Without this, peers that
      // already received the public face/back URLs at spawn time could read
      // them off their cached mesh material via a camera fly-around.
      this.reEmitPrivateFields(entity);
    }
    this.arrangeContents();
  }

  private handleExit(entity: Entity): void {
    if (!this.world) return;
    this.setEntityPrivateToSeat(entity, null);
    // Mirror handleEnter: re-emit so non-owners receive the real (unscrubbed)
    // values back once the card is no longer private.
    this.reEmitPrivateFields(entity);
    this.arrangeContents();
  }

  private setEntityPrivateToSeat(entity: Entity, seat: SeatIndex | null): void {
    if (entity.privateToSeat === seat) return;
    entity.privateToSeat = seat;
    this.world?.enqueueEntityPatch(entity.id, { privateToSeat: seat });
  }

  // Forces a setState round-trip on each privacy-sensitive component so a
  // patch flows through replication. The PrivacyScrubber substitutes empty
  // strings for non-owner recipients while owners receive the real values.
  private reEmitPrivateFields(entity: Entity): void {
    const card = entity.getComponent(CardComponent);
    if (card) card.setState({ face: card.state.face, back: card.state.back });
    const flat = entity.getComponent(FlatViewComponent);
    if (flat) flat.setState({ textureRef: flat.state.textureRef });
  }

  // ── Slot layout ──────────────────────────────────────────────────────
  // Slots are evenly spaced along the hand's local +X axis at y=0, z=0 in
  // zone-local space. Spacing = min(zoneWidth/(N+1), oneCardWidth). Hand
  // rotation propagates to each slot pose so cards inherit the hand's
  // orientation (face-up toward the owner).
  private computeSlotPoses(zone: ZoneComponent, n: number): Array<{
    position: [number, number, number];
    rotation: [number, number, number, number];
  }> {
    if (n === 0) return [];
    const transform = this.entity.getComponent(TransformComponent);
    if (!transform) return [];

    const zoneWidth = zone.state.halfExtents[0] * 2;
    const spacing   = Math.min(zoneWidth / (n + 1), ONE_CARD_WIDTH);

    const [hpx, hpy, hpz]      = transform.state.position;
    const [hqx, hqy, hqz, hqw] = transform.state.rotation;
    _q.set(hqx, hqy, hqz, hqw);

    const result = [] as Array<{
      position: [number, number, number];
      rotation: [number, number, number, number];
    }>;
    for (let i = 0; i < n; i++) {
      const localX = (i - (n - 1) / 2) * spacing;
      const localY = i * SLOT_LIFT_PER_INDEX;
      _v.set(localX, localY, 0).applyQuaternion(_q);
      result.push({
        position: [hpx + _v.x, hpy + _v.y, hpz + _v.z],
        rotation: [hqx, hqy, hqz, hqw],
      });
    }
    return result;
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  // ── isMainHand uniqueness ────────────────────────────────────────────
  // Host-side: when this hand becomes main, clear the flag on every sibling
  // hand owned by the same seat. Sibling.setState will replicate the clear.
  private clearSiblingMainHandFlags(): void {
    const scene = this.entity.scene;
    if (!scene) return;
    const myOwner = this.entity.owner;
    for (const e of scene.all()) {
      if (e === this.entity) continue;
      const sibling = e.getComponent(HandComponent);
      if (!sibling) continue;
      if (!sibling.state.isMainHand) continue;
      if (e.owner !== myOwner) continue;
      sibling.setState({ isMainHand: false });
    }
  }
}

function sameArrayOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

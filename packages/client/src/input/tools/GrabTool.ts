// GrabTool — migrated DragController logic, issue 2a of issues--tools.md.
//
// One GrabTool runs on host and guest. Mutation verbs (tryHold, setPosition,
// release) route through EntityHandle, which the World resolves per role.
// Click vs. carry distinguished by the existing 150ms / 5px thresholds.
// Axis-drag promoted from a gizmo-arm pick. Owns an AxisGizmoAttachment that
// follows the current selection while this tool is active.

import * as THREE from 'three';
import { type EntityHandle } from '../../entity/world';
import { TransformComponent } from '../../entity/components/TransformComponent';
import { PhysicsComponent } from '../../entity/components/PhysicsComponent';
import { TableComponent } from '../../entity/components/TableComponent';
import {
  CARRY_LIFT_HEIGHT,
  GRAB_LONG_PRESS_MS,
  GRAB_MOVE_THRESHOLD_PX,
  THROW_VELOCITY_WINDOW_MS,
} from '../../config/dragConfig';
import { type MoveGizmo, type GizmoAxis } from '../../scene/MoveGizmo';
import { projectRayOntoAxis } from '../axisDrag';
import { type Tool, type ToolContext, type ToolPointerEvent } from './types';
import { type AxisGizmoAttachment } from './AxisGizmoAttachment';
import { type HitboxAttachment } from './HitboxAttachment';
import { findDropTargetAt } from '../dropTargetRegistry';
import { type PeelAndHoldResult } from '../../entity/wire';
import { type SeatIndex } from '../../seats/SeatLayout';

const VELOCITY_SAMPLES = 20;

type Pending = {
  handle:    EntityHandle;
  startX:    number;
  startY:    number;
  startT:    number;
  pointerId: number;
};

type AxisDrag = {
  handle:    EntityHandle;
  axis:      THREE.Vector3;
  origin:    THREE.Vector3;
  grabAxisT: number;
  current:   THREE.Vector3;
  active:    boolean;  // false until host echoes the hold-claim
};

type CarryDrag = {
  handle: EntityHandle;
  active: boolean;     // false while waiting for guest hold-claim echo
};

// Short-press peel — issue #2 of issues--deck-peel.md. Lives parallel to
// CarryDrag. Created when GrabTool's commit point sees `{ kind: 'peel' }`
// from Entity.tryGrab; the world's peelAndHold returns a promise that
// resolves with the new card id + pose. The tool stays in this state until
// the reply arrives AND the new card is in scene held by self — then
// transitions to a regular Carry.
type PendingPeel = {
  sourceId:      string;
  pointerId:     number;
  holdOffsetX:   number;
  holdOffsetZ:   number;
  holdY:         number;
  reply:         PeelAndHoldResult | null;
  replyReceived: boolean;
  // True once the user has released the pointer (or the tool was cancelled)
  // before the reply arrived. The pending-peel closure detects this and
  // releases any peeled card on arrival.
  canceled:      boolean;
};

export class GrabTool implements Tool {
  readonly id     = 'grab';
  readonly label  = 'Grab';
  readonly hotkey = '1';

  private pending:      Pending | null = null;
  private pendingEmpty: { pointerId: number } | null = null;
  private pendingPeel:  PendingPeel | null = null;
  private carry:        CarryDrag | null = null;
  private axisDrag:     AxisDrag  | null = null;

  private holdOffsetX = 0;
  private holdOffsetZ = 0;
  private holdY       = 0;

  private readonly carryPlane  = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly carryTarget = new THREE.Vector3();
  private readonly velHistory:  { pos: THREE.Vector3; t: number }[] = [];

  private active           = false;
  private selectedEntityId: string | null = null;

  constructor(
    private readonly gizmo:             MoveGizmo,
    private readonly attachment:        AxisGizmoAttachment,
    private readonly hitboxAttachment:  HitboxAttachment,
    private readonly onSelect:          (id: string | null) => void,
  ) {}

  // Exposed for the host-side toggle. ThreeCanvas calls this when the
  // "Show Hitboxes" checkbox flips; passing the current selection so an
  // already-selected entity gains/loses its wireframe immediately.
  setShowHitboxes(on: boolean, ctx: ToolContext): void {
    const handle = this.selectedEntityId && this.active
      ? (ctx.world.get(this.selectedEntityId) ?? null)
      : null;
    this.hitboxAttachment.setEnabled(on, handle, ctx);
  }

  // ── Public API for ThreeCanvas ─────────────────────────────────────────
  setSelection(id: string | null, ctx: ToolContext): void {
    if (this.selectedEntityId === id) return;
    this.selectedEntityId = id;
    if (this.active) this.syncAttachment(ctx);
  }

  hasActiveGesture(): boolean {
    return this.pending !== null
        || this.pendingEmpty !== null
        || this.pendingPeel !== null
        || this.carry !== null
        || this.axisDrag !== null;
  }

  // ── Tool lifecycle ─────────────────────────────────────────────────────
  onActivate(ctx: ToolContext): void {
    this.active = true;
    this.syncAttachment(ctx);
  }

  onDeactivate(ctx: ToolContext): void {
    this.active = false;
    this.attachment.detach();
    this.hitboxAttachment.detach();
    // Drop any in-flight gesture as a safety net — caller usually rejects
    // tool-switch during an active gesture, but onDeactivate must leave a
    // clean slate either way.
    this.cancelGesture(ctx);
  }

  onCancel(ctx: ToolContext): void {
    this.cancelGesture(ctx);
  }

  // ── Pointer hooks ──────────────────────────────────────────────────────
  onPress(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    if (this.carry || this.axisDrag || this.pending || this.pendingEmpty || this.pendingPeel) return;

    // Gizmo arms take priority over the object body.
    ctx.raycaster.set(e.ray.origin, e.ray.direction);
    const axisName = this.gizmo.pickAxis(ctx.raycaster);
    if (axisName) {
      const target = this.gizmo.getTarget();
      const handle = target ? ctx.world.pickByObject3D(target) : undefined;
      if (handle) {
        if (!handle.canStartDrag()) return;
        const seat = ctx.getSelfSeat();
        if (seat === null) return;
        if (!handle.tryHold(seat)) return;
        this.beginAxisDrag(handle, axisName, ctx);
        ctx.element.setPointerCapture(e.pointerId);
        return;
      }
    }

    const meshes: THREE.Object3D[] = [];
    ctx.world.forEach((h) => {
      const t = h.get(TransformComponent);
      if (t?.object3d) meshes.push(t.object3d);
    });
    const hits = ctx.raycaster.intersectObjects(meshes, true);

    if (hits.length === 0) {
      this.pendingEmpty = { pointerId: e.pointerId };
      ctx.element.setPointerCapture(e.pointerId);
      return;
    }

    const handle = ctx.world.pickByObject3D(hits[0].object);
    if (!handle) return;
    // Hit on the singleton Table is treated as a click on empty space — the
    // Table is locked, never carried, never selected via 3D click. Falling
    // through to pendingEmpty (instead of returning a no-op) means a
    // short-press release still clears any prior selection.
    if (handle.entity.hasComponent(TableComponent)) {
      this.pendingEmpty = { pointerId: e.pointerId };
      ctx.element.setPointerCapture(e.pointerId);
      return;
    }
    if (!handle.canStartDrag()) return;

    this.pending = {
      handle,
      startX:    e.clientX,
      startY:    e.clientY,
      startT:    e.timestamp,
      pointerId: e.pointerId,
    };
    ctx.element.setPointerCapture(e.pointerId);
  }

  onMove(e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.axisDrag) {
      ctx.raycaster.set(e.ray.origin, e.ray.direction);
      const a = this.axisDrag;
      const t = projectRayOntoAxis(ctx.raycaster.ray, a.origin, a.axis, ctx.camera.position);
      if (t === null) return;
      const delta = t - a.grabAxisT;
      a.current.set(
        a.origin.x + a.axis.x * delta,
        a.origin.y + a.axis.y * delta,
        a.origin.z + a.axis.z * delta,
      );
      return;
    }

    if (this.pending) {
      const dx = e.clientX - this.pending.startX;
      const dy = e.clientY - this.pending.startY;
      if (dx * dx + dy * dy > GRAB_MOVE_THRESHOLD_PX * GRAB_MOVE_THRESHOLD_PX) this.beginCarry(this.pending, ctx, false);
    }
    if (!this.carry && !this.pendingPeel) return;
    ctx.raycaster.set(e.ray.origin, e.ray.direction);
    const pt = this.castToCarryPlane(ctx.raycaster);
    if (!pt) return;
    this.carryTarget.set(pt.x + this.holdOffsetX, this.holdY, pt.z + this.holdOffsetZ);
    this.velHistory.push({ pos: pt.clone(), t: e.timestamp });
    if (this.velHistory.length > VELOCITY_SAMPLES) this.velHistory.shift();
  }

  onRelease(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;

    if (this.axisDrag) {
      this.axisDrag.handle.release();
      this.axisDrag = null;
      return;
    }

    if (this.carry) {
      const handle = this.carry.handle;
      const wasActive = this.carry.active;
      this.carry = null;
      if (wasActive) {
        // Drop target under the cursor wins over throw velocity. Releases
        // the hold (no throw) and tweens the entity into the destination
        // hand — zone-enter then runs HandComponent's slot logic.
        const drop = findDropTargetAt(e.clientX, e.clientY);
        if (drop?.kind === 'hand-panel') {
          handle.release();
          ctx.world.tweenIntoHand(handle.entity, drop.handEntityId);
          this.velHistory.length = 0;
          return;
        }
        const vel = this.computeThrowVelocity(e.timestamp);
        handle.release({ vx: vel.x, vy: 0, vz: vel.z });
      } else {
        // Hold-claim never confirmed — defensive release (idempotent on host).
        handle.release();
      }
      this.velHistory.length = 0;
      return;
    }

    if (this.pendingPeel) {
      // Pointer released before (or after) the host's reply. Either way the
      // peeled card sits at the deck's pose — no throw applies; no Carry
      // ever began. cleanupPendingPeel releases the peeled card, threading
      // through the still-pending closure when the reply hasn't arrived.
      this.cleanupPendingPeel(ctx);
      this.velHistory.length = 0;
      return;
    }

    if (this.pending) {
      this.onSelect(this.pending.handle.id);
      this.pending = null;
      return;
    }

    if (this.pendingEmpty) {
      this.onSelect(null);
      this.pendingEmpty = null;
    }
  }

  // ── Per-frame tick ─────────────────────────────────────────────────────
  update(_dt: number, ctx: ToolContext): void {
    if (this.pending && performance.now() - this.pending.startT >= GRAB_LONG_PRESS_MS) {
      this.beginCarry(this.pending, ctx, true);
    }

    // PendingPeel → Carry transition. Mirrors the host hold-claim echo wait
    // for axis/carry drags, but keyed on the new card id from the reply.
    if (this.pendingPeel && this.pendingPeel.replyReceived
        && !this.pendingPeel.canceled
        && this.pendingPeel.reply !== null) {
      const seat       = ctx.getSelfSeat();
      const cardHandle = ctx.world.get(this.pendingPeel.reply.cardId);
      if (seat !== null && cardHandle && cardHandle.heldBy() === seat) {
        const t      = cardHandle.get(TransformComponent);
        const cardY  = t?.object3d.position.y ?? (this.pendingPeel.holdY - CARRY_LIFT_HEIGHT);
        this.holdY               = cardY + CARRY_LIFT_HEIGHT;
        this.carryPlane.constant = -this.holdY;
        this.carry = { handle: cardHandle, active: true };
        this.pendingPeel = null;
      }
    }

    if (this.carry && !this.carry.active) {
      const seat = ctx.getSelfSeat();
      if (seat !== null && this.carry.handle.heldBy() === seat) {
        this.carry.active = true;
      }
    }

    if (this.axisDrag && !this.axisDrag.active) {
      const seat = ctx.getSelfSeat();
      if (seat !== null && this.axisDrag.handle.heldBy() === seat) {
        this.axisDrag.active = true;
      }
    }

    if (this.carry?.active) {
      this.carry.handle.setPosition(this.carryTarget.x, this.holdY, this.carryTarget.z);
    }

    if (this.axisDrag?.active) {
      const a = this.axisDrag;
      a.handle.setPosition(a.current.x, a.current.y, a.current.z);
    }

    this.attachment.update(_dt);
    this.hitboxAttachment.update(_dt);
  }

  // ── Internals ──────────────────────────────────────────────────────────
  private syncAttachment(ctx: ToolContext): void {
    if (!this.active) {
      this.attachment.detach();
      this.hitboxAttachment.detach();
      return;
    }
    if (this.selectedEntityId === null) {
      this.attachment.detach();
      this.hitboxAttachment.detach();
      return;
    }
    const handle = ctx.world.get(this.selectedEntityId);
    if (!handle) {
      this.attachment.detach();
      this.hitboxAttachment.detach();
      return;
    }
    this.attachment.attach(handle, ctx);
    this.hitboxAttachment.attach(handle, ctx);
  }

  private cancelGesture(ctx: ToolContext): void {
    if (this.carry) {
      this.carry.handle.release();
      this.carry = null;
    }
    if (this.axisDrag) {
      this.axisDrag.handle.release();
      this.axisDrag = null;
    }
    if (this.pendingPeel) {
      this.cleanupPendingPeel(ctx);
    }
    this.pending      = null;
    this.pendingEmpty = null;
    this.velHistory.length = 0;
  }

  // Tear down a PendingPeel before its host reply has been consumed. Sets
  // the canceled flag so the still-pending closure releases any peeled card
  // on arrival; if the closure has already run, releases the peeled card
  // now via the world handle.
  private cleanupPendingPeel(ctx: ToolContext): void {
    const peel = this.pendingPeel;
    if (!peel) return;
    this.pendingPeel = null;
    peel.canceled = true;
    if (peel.replyReceived && peel.reply !== null) {
      ctx.world.get(peel.reply.cardId)?.release();
    }
  }

  private castToCarryPlane(raycaster: THREE.Raycaster): THREE.Vector3 | null {
    const pt = new THREE.Vector3();
    return raycaster.ray.intersectPlane(this.carryPlane, pt) ? pt : null;
  }

  // Promote a pending pointer down to a hold attempt. Sends the hold-claim
  // (host: synchronous; guest: RPC). Carry is "inactive" until the host's
  // echo flips heldBy(); update() activates it on the next tick.
  // `isLongPress` is decided by the trigger, not the clock: onMove past the
  // distance threshold passes false (fast move = short press), update()'s
  // timer passes true (held without movement = long press). Mixing the two
  // — e.g. classifying a slow drag past 150ms as long-press — silently
  // suppresses peel intent and carries the whole deck instead.
  private beginCarry(p: Pending, ctx: ToolContext, isLongPress: boolean): void {
    this.pending = null;
    if (!p.handle.canStartDrag()) return;
    const seat = ctx.getSelfSeat();
    if (seat === null) return;

    const intent = p.handle.entity.tryGrab(isLongPress);
    if (intent.kind === 'peel') {
      this.beginPeel(p, intent.sourceId, ctx, seat);
      return;
    }

    if (p.handle.entity.heldBy !== null) return;
    if (!p.handle.tryHold(seat)) return;

    this.carry = { handle: p.handle, active: false };
    this.velHistory.length = 0;

    const t      = p.handle.get(TransformComponent);
    const meshY  = t?.object3d.position.y ?? 0;
    const meshX  = t?.object3d.position.x ?? 0;
    const meshZ  = t?.object3d.position.z ?? 0;
    this.holdY               = meshY + CARRY_LIFT_HEIGHT;
    this.carryPlane.constant = -this.holdY;

    const pt = this.castToCarryPlane(ctx.raycaster);
    if (pt) {
      this.holdOffsetX = meshX - pt.x;
      this.holdOffsetZ = meshZ - pt.z;
      this.carryTarget.set(pt.x + this.holdOffsetX, this.holdY, pt.z + this.holdOffsetZ);
      this.velHistory.push({ pos: pt.clone(), t: performance.now() });
    } else {
      this.holdOffsetX = 0;
      this.holdOffsetZ = 0;
    }
  }

  // Commit to a peel-style grab: capture the carry plane / hold offset
  // against the deck's current pose, fire World.peelAndHold, park in
  // PendingPeel until the reply + entity arrival lets update() transition
  // to a regular Carry. p.handle is the deck (the source); the carried
  // entity is the freshly-peeled card delivered by the host's reply.
  private beginPeel(p: Pending, sourceId: string, ctx: ToolContext, seat: SeatIndex): void {
    const deckT  = p.handle.get(TransformComponent);
    const deckX  = deckT?.object3d.position.x ?? 0;
    const deckY  = deckT?.object3d.position.y ?? 0;
    const deckZ  = deckT?.object3d.position.z ?? 0;
    const holdY  = deckY + CARRY_LIFT_HEIGHT;
    this.holdY               = holdY;
    this.carryPlane.constant = -holdY;
    this.velHistory.length   = 0;

    let holdOffsetX = 0;
    let holdOffsetZ = 0;
    const pt = this.castToCarryPlane(ctx.raycaster);
    if (pt) {
      holdOffsetX = deckX - pt.x;
      holdOffsetZ = deckZ - pt.z;
      this.carryTarget.set(pt.x + holdOffsetX, holdY, pt.z + holdOffsetZ);
      this.velHistory.push({ pos: pt.clone(), t: performance.now() });
    }
    this.holdOffsetX = holdOffsetX;
    this.holdOffsetZ = holdOffsetZ;

    const peel: PendingPeel = {
      sourceId,
      pointerId:     p.pointerId,
      holdOffsetX, holdOffsetZ, holdY,
      reply:         null,
      replyReceived: false,
      canceled:      false,
    };
    this.pendingPeel = peel;

    ctx.world.peelAndHold(sourceId, seat).then((reply) => {
      peel.reply         = reply;
      peel.replyReceived = true;
      const stillCurrent = this.pendingPeel === peel;
      if (peel.canceled || reply === null) {
        // User released / canceled in flight, or the host rejected. If a card
        // was peeled, release it now so it sits visibly at the deck's pose.
        if (reply !== null) ctx.world.get(reply.cardId)?.release();
        if (stillCurrent) {
          this.pendingPeel = null;
          this.velHistory.length = 0;
        }
        return;
      }
      // Reply OK + user still holding. update() will pick up the transition
      // to Carry once the new card's heldBy === self seat.
    });
  }

  private beginAxisDrag(handle: EntityHandle, axisName: GizmoAxis, ctx: ToolContext): void {
    const phys = handle.get(PhysicsComponent);
    const t    = handle.get(TransformComponent);
    const pose = phys?.body?.position ?? t?.object3d.position;
    if (!pose) return;
    const axis = axisName === 'x' ? new THREE.Vector3(1, 0, 0)
              :  axisName === 'y' ? new THREE.Vector3(0, 1, 0)
              :                     new THREE.Vector3(0, 0, 1);
    const origin    = new THREE.Vector3(pose.x, pose.y, pose.z);
    const grabAxisT = projectRayOntoAxis(ctx.raycaster.ray, origin, axis, ctx.camera.position) ?? 0;
    this.axisDrag = {
      handle,
      axis,
      origin,
      grabAxisT,
      current: origin.clone(),
      // Host: hold-claim already succeeded synchronously, drag is live.
      // Guest: wait for the host's echo before streaming positions.
      active: ctx.world.get(handle.id) !== undefined && handle.heldBy() === ctx.getSelfSeat(),
    };
  }

  private computeThrowVelocity(now: number): THREE.Vector3 {
    if (this.velHistory.length === 0) return new THREE.Vector3();
    const last   = this.velHistory[this.velHistory.length - 1];
    const cutoff = now - THROW_VELOCITY_WINDOW_MS;
    let first = last;
    for (let i = this.velHistory.length - 1; i >= 0; i--) {
      if (this.velHistory[i].t < cutoff) break;
      first = this.velHistory[i];
    }
    const dt = (now - first.t) / 1000;
    if (dt < 0.001) return new THREE.Vector3();
    return new THREE.Vector3(
      (last.pos.x - first.pos.x) / dt,
      0,
      (last.pos.z - first.pos.z) / dt,
    );
  }
}

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
  GRAB_LONG_PRESS_MS,
  GRAB_MOVE_THRESHOLD_PX,
  HOVER_OFFSET,
  THROW_VELOCITY_THRESHOLD,
  THROW_VELOCITY_WINDOW_MS,
  Y_LERP_TIME_CONSTANT_S,
} from '../../config/dragConfig';
import { type MoveGizmo, type GizmoAxis } from '../../scene/MoveGizmo';
import { type RotateGizmo } from '../../scene/RotateGizmo';
import { projectRayOntoAxis } from '../axisDrag';
import { resolveDragTarget } from '../DragTargetResolver';
import { MeshComponent } from '../../entity/components/MeshComponent';
import { type Tool, type ToolContext, type ToolPointerEvent } from './types';
import { type SelectionClickModifier } from '../SelectionStore';
import { GroupDragController } from '../GroupDragController';
import { type Pose } from '../GroupTransform';
import { type AxisGizmoAttachment } from './AxisGizmoAttachment';
import { type HitboxAttachment } from './HitboxAttachment';
import { type DropPreviewGhost } from './DropPreviewGhost';
import { type MarqueeOverlay } from './MarqueeOverlay';
import { entitiesInMarquee, ndcRectFromScreen, type CandidateInput } from '../marqueeProjection';
import { TABLE_ENTITY_ID } from '../../entity/tableEntity';
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
  modifier:  SelectionClickModifier;
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

// Slice #2 of issues--marquee.md — empty-press drag that draws a screen-space
// rectangle and selects every eligible entity inside it on release. Modifier
// is captured at press time and applied to `applySelectionMarquee` once at
// release, mirroring the click-matrix lift from `applySelectionClick`.
type MarqueeDrag = {
  startClientX: number;
  startClientY: number;
  modifier:     SelectionClickModifier;
  candidates:   Set<string>;
};

// Slice #6 — rotation drag of a multi-selection around the centroid gizmo.
// Pivot is captured at gesture start and stays fixed; the start angle is
// the cursor's angle around the pivot (XZ plane) the moment the ring was
// picked. Per-frame, the current cursor angle drives `applyPivotedRotation`
// with the total delta — never an incremental one — so float error doesn't
// accumulate over the gesture.
type RotateDrag = {
  pivot:      [number, number, number];
  startAngle: number;
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
  private pendingEmpty: { pointerId: number; modifier: SelectionClickModifier; startX: number; startY: number } | null = null;
  private pendingPeel:  PendingPeel | null = null;
  private carry:        CarryDrag | null = null;
  private axisDrag:     AxisDrag  | null = null;
  private rotateDrag:   RotateDrag | null = null;
  private marqueeDrag:  MarqueeDrag | null = null;

  // Current rendered Y of the held entity. Eases toward `targetY` with a
  // ~Y_LERP_TIME_CONSTANT_S time constant in update().
  private holdY       = 0;
  // Most recent resolver-derived target Y. X/Z follows cursor 1:1; only Y
  // eases between hover heights. Issue #2 of issues--drag-refactor.md.
  private targetY     = 0;
  // Last valid hover Y from a bare-surface hit. When the cursor leaves the
  // table the resolver projects onto this Y so the entity tracks cursor X/Z
  // without snapping vertically. Initialised at carry start.
  private lastValidY  = 0;
  // Half of the dragged entity's mesh height. Cached at carry start so the
  // resolver doesn't have to look it up every frame. Defaults to 0 when the
  // entity has no MeshComponent (test fixtures, ungeometried entities).
  private draggedHalfExtentY = 0;
  // Most recent surfaceY from the resolver — `null` when the resolver
  // returned `none` (off-table fallback). Feeds DropPreviewGhost each frame
  // so the ghost hides over the fallback plane.
  private currentSurfaceY: number | null = null;
  // Most recent cursor speed (world units/sec), sampled from velHistory the
  // same way `computeThrowVelocity` samples for release. Gates the ghost
  // visibility (and at release, the throw vs. drop branch). Issue #4 of
  // issues--drag-refactor.md.
  private cursorSpeed = 0;

  private readonly carryTarget = new THREE.Vector3();
  private readonly velHistory:  { pos: THREE.Vector3; t: number }[] = [];

  private active           = false;
  // Last solo selection (size === 1). Drives gizmo attachment + ZoneComponent
  // debug visibility — unchanged from single-select behavior.
  private selectedEntityId: string | null = null;
  // Full multi-selection set. Drives group-drag eligibility in beginCarry.
  private selectedIds:      ReadonlySet<string> = new Set();
  private readonly groupController = new GroupDragController();

  constructor(
    private readonly gizmo:             MoveGizmo,
    private readonly rotateGizmo:       RotateGizmo,
    private readonly attachment:        AxisGizmoAttachment,
    private readonly hitboxAttachment:  HitboxAttachment,
    private readonly dropPreviewGhost:  DropPreviewGhost,
    private readonly marqueeOverlay:    MarqueeOverlay,
    private readonly onSelect:          (id: string | null, modifier: SelectionClickModifier) => void,
    private readonly onMarqueeCommit:   (candidates: ReadonlySet<string>, modifier: SelectionClickModifier) => void,
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
  setSelection(ids: ReadonlySet<string>, ctx: ToolContext): void {
    this.selectedIds = ids;
    // Gizmo attaches only on solo selection — multi-select hides the per-
    // entity gizmo so it doesn't conflict with the future centroid gizmo.
    const solo = ids.size === 1 ? (ids.values().next().value ?? null) : null;
    if (this.selectedEntityId === solo) return;
    this.selectedEntityId = solo;
    if (this.active) this.syncAttachment(ctx);
  }

  hasActiveGesture(): boolean {
    return this.pending !== null
        || this.pendingEmpty !== null
        || this.pendingPeel !== null
        || this.carry !== null
        || this.axisDrag !== null
        || this.rotateDrag !== null
        || this.marqueeDrag !== null;
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
    if (this.carry || this.axisDrag || this.rotateDrag || this.marqueeDrag || this.pending || this.pendingEmpty || this.pendingPeel) return;

    const modifier: SelectionClickModifier =
        e.shiftKey ? 'shift'
      : e.ctrlKey  ? 'ctrl'
      :              'plain';

    // Gizmo arms take priority over the object body.
    ctx.raycaster.set(e.ray.origin, e.ray.direction);

    // Rotate-ring pick (multi-select centroid gizmo). Engages a yaw drag
    // against a frozen pivot — every member of the active selection rotates
    // around the centroid as the cursor sweeps around it.
    const centroid = this.attachment.getRotateCentroid();
    if (centroid && this.rotateGizmo.pickRing(ctx.raycaster)) {
      const seat = ctx.getSelfSeat();
      if (seat === null) return;
      if (this.beginGroupRotate(centroid, ctx, seat, e)) {
        ctx.element.setPointerCapture(e.pointerId);
        return;
      }
    }

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
      this.pendingEmpty = { pointerId: e.pointerId, modifier, startX: e.clientX, startY: e.clientY };
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
      this.pendingEmpty = { pointerId: e.pointerId, modifier, startX: e.clientX, startY: e.clientY };
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
      modifier,
    };
    ctx.element.setPointerCapture(e.pointerId);
  }

  onMove(e: ToolPointerEvent, ctx: ToolContext): void {
    if (this.rotateDrag) {
      const angle = this.cursorAngleAroundPivot(e, this.rotateDrag.pivot);
      if (angle === null) return;
      const delta = angle - this.rotateDrag.startAngle;
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), delta);
      this.groupController.applyPivotedRotation(q, this.rotateDrag.pivot);
      return;
    }

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

    if (this.marqueeDrag) {
      this.updateMarquee(e, ctx);
      return;
    }

    if (this.pendingEmpty) {
      const dx = e.clientX - this.pendingEmpty.startX;
      const dy = e.clientY - this.pendingEmpty.startY;
      if (dx * dx + dy * dy > GRAB_MOVE_THRESHOLD_PX * GRAB_MOVE_THRESHOLD_PX) {
        this.beginMarquee(e, ctx);
      }
      return;
    }

    if (this.pending) {
      const dx = e.clientX - this.pending.startX;
      const dy = e.clientY - this.pending.startY;
      if (dx * dx + dy * dy > GRAB_MOVE_THRESHOLD_PX * GRAB_MOVE_THRESHOLD_PX) this.beginCarry(this.pending, ctx, false);
    }
    if (!this.carry && !this.pendingPeel) return;
    ctx.raycaster.set(e.ray.origin, e.ray.direction);
    const draggedId = this.carry?.handle.id ?? this.pendingPeel?.sourceId ?? null;
    const result = resolveDragTarget({
      raycaster:          ctx.raycaster,
      candidateMeshes:    this.collectCandidateMeshes(ctx, draggedId),
      draggedHalfExtentY: this.draggedHalfExtentY,
      hoverOffset:        HOVER_OFFSET,
      fallbackY:          this.lastValidY,
    });
    this.carryTarget.set(result.position.x, result.position.y, result.position.z);
    this.targetY = result.position.y;
    if (result.kind === 'bare') {
      this.lastValidY      = result.position.y;
      this.currentSurfaceY = result.surfaceY;
    } else {
      this.currentSurfaceY = null;
    }
    this.velHistory.push({
      pos: new THREE.Vector3(result.position.x, result.position.y, result.position.z),
      t:   e.timestamp,
    });
    if (this.velHistory.length > VELOCITY_SAMPLES) this.velHistory.shift();
    this.cursorSpeed = this.computeThrowVelocity(e.timestamp).length();
  }

  onRelease(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;

    if (this.rotateDrag) {
      this.rotateDrag = null;
      this.groupController.release();
      this.attachment.update(0);
      return;
    }

    if (this.marqueeDrag) {
      const { candidates, modifier } = this.marqueeDrag;
      this.marqueeDrag = null;
      this.marqueeOverlay.detach();
      this.onMarqueeCommit(candidates, modifier);
      return;
    }

    if (this.axisDrag) {
      this.axisDrag.handle.release();
      this.axisDrag = null;
      return;
    }

    if (this.carry) {
      const handle = this.carry.handle;
      const wasActive = this.carry.active;
      const group = this.groupController.current();
      const hasGroupMembers = (group?.members.length ?? 0) > 0;
      // Peel-transitioned carry bypasses the controller (the new card was
      // claimed inside World.peelAndHold, not via GroupDragController.begin).
      // Route release through the controller only when it's actually
      // managing this carry.
      const releaseAll = (velocity?: { vx: number; vy: number; vz: number }) => {
        if (group) this.groupController.release(velocity);
        else       handle.release(velocity);
      };
      this.carry = null;
      this.dropPreviewGhost.detach();
      if (wasActive) {
        // Drop target under the cursor wins over throw velocity, but only
        // for single-entity drag. A group drop into a hand panel is
        // ambiguous (which entity becomes the hand tile?) so the group
        // path falls through to the regular throw / drop release.
        if (!hasGroupMembers) {
          const drop = findDropTargetAt(e.clientX, e.clientY);
          if (drop?.kind === 'hand-panel') {
            releaseAll();
            ctx.world.tweenIntoHand(handle.entity, drop.handEntityId);
            this.velHistory.length = 0;
            return;
          }
        }
        const vel = this.computeThrowVelocity(e.timestamp);
        if (vel.length() >= THROW_VELOCITY_THRESHOLD) {
          releaseAll({ vx: vel.x, vy: 0, vz: vel.z });
        } else {
          // Slow release: no throw. Body returns to DYNAMIC (via HoldService)
          // and gravity drops the entity from its hover Y.
          releaseAll();
        }
      } else {
        // Hold-claim never confirmed — defensive release (idempotent on host).
        releaseAll();
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
      this.onSelect(this.pending.handle.id, this.pending.modifier);
      this.pending = null;
      return;
    }

    if (this.pendingEmpty) {
      this.onSelect(null, this.pendingEmpty.modifier);
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
        const cardY  = t?.object3d.position.y ?? (this.pendingPeel.holdY - HOVER_OFFSET);
        this.holdY              = cardY + HOVER_OFFSET;
        this.targetY            = this.holdY;
        this.lastValidY         = this.holdY;
        this.draggedHalfExtentY = this.readHalfExtentY(cardHandle);
        this.carry = { handle: cardHandle, active: true };
        this.pendingPeel = null;
      }
    }

    if (this.carry && !this.carry.active) {
      const seat = ctx.getSelfSeat();
      if (seat !== null && this.carry.handle.heldBy() === seat) {
        this.carry.active = true;
        // First frame as an active carry — bring up the ghost preview. The
        // hold-claim echo may have arrived before any onMove ran, so attach
        // here rather than in beginCarry.
        if (!this.dropPreviewGhost.isAttached()) this.dropPreviewGhost.attach(this.carry.handle);
      }
    }

    if (this.axisDrag && !this.axisDrag.active) {
      const seat = ctx.getSelfSeat();
      if (seat !== null && this.axisDrag.handle.heldBy() === seat) {
        this.axisDrag.active = true;
      }
    }

    if (this.carry?.active) {
      // Exponential ease toward the resolver's targetY with a fixed time
      // constant; X/Z follows cursor 1:1.
      const k = 1 - Math.exp(-_dt / Y_LERP_TIME_CONSTANT_S);
      this.holdY += (this.targetY - this.holdY) * k;
      this.carry.handle.setPosition(this.carryTarget.x, this.holdY, this.carryTarget.z);
      // Group drag: drive each claimed member off the anchor's new world
      // position. No-op when `members` is empty (single-entity drag).
      this.groupController.applyAnchorTranslation(
        this.carryTarget.x, this.holdY, this.carryTarget.z,
      );
      // Ghost hidden while the cursor is moving fast enough that release
      // would throw — only useful as a placement hint during slow drags.
      const ghostY = this.cursorSpeed < THROW_VELOCITY_THRESHOLD ? this.currentSurfaceY : null;
      this.dropPreviewGhost.update(ghostY);
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
    // Multi-selection: attach the centroid rotate gizmo. Hitbox treatment
    // stays per-entity-solo (the hitbox visualiser is a debug feature for
    // single-entity inspection).
    if (this.selectedIds.size > 1) {
      const poses: Pose[] = [];
      for (const id of this.selectedIds) {
        const t = ctx.world.get(id)?.get(TransformComponent)?.object3d;
        if (!t) continue;
        const p = t.position;
        const q = t.quaternion;
        poses.push({
          position: [p.x, p.y, p.z],
          rotation: [q.x, q.y, q.z, q.w],
        });
      }
      this.attachment.attachGroup(poses, ctx);
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
      // Same peel-vs-group branch as onRelease: peel-transitioned carry
      // releases directly via the handle (the controller isn't aware of
      // it); a true group drag goes through the controller.
      if (this.groupController.current()) this.groupController.release();
      else                                this.carry.handle.release();
      this.carry = null;
    }
    if (this.axisDrag) {
      this.axisDrag.handle.release();
      this.axisDrag = null;
    }
    if (this.rotateDrag) {
      this.rotateDrag = null;
      this.groupController.release();
    }
    if (this.marqueeDrag) {
      this.marqueeDrag = null;
      this.marqueeOverlay.detach();
    }
    if (this.pendingPeel) {
      this.cleanupPendingPeel(ctx);
    }
    this.dropPreviewGhost.detach();
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

  // Gather raycast candidates for the drag resolver. Excludes the dragged
  // entity itself (or the peel source — the soon-to-be-peeled card is part of
  // the source deck) and any entity currently held by any seat. The Table is
  // included — it's a valid hover surface.
  private collectCandidateMeshes(ctx: ToolContext, draggedId: string | null): THREE.Object3D[] {
    const meshes: THREE.Object3D[] = [];
    ctx.world.forEach((h) => {
      if (h.id === draggedId) return;
      if (h.entity.heldBy !== null) return;
      const t = h.get(TransformComponent);
      if (t?.object3d) meshes.push(t.object3d);
    });
    return meshes;
  }

  // Half of the entity's mesh bounding height. Defaults to 0 for entities
  // without a MeshComponent (test fixtures) so the resolver doesn't add an
  // undefined gap. Real entities expose this through MeshComponent.halfExtents.
  private readHalfExtentY(handle: EntityHandle): number {
    const mesh = handle.get(MeshComponent);
    return mesh?.halfExtents()[1] ?? 0;
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

    // Group-drag eligibility: the anchor must be a member of the current
    // multi-selection. If the anchor isn't selected, this is a regular
    // single-entity drag (members = []) and the controller behaves as a
    // thin wrapper around the existing hold-claim path.
    const others: EntityHandle[] = [];
    if (this.selectedIds.size > 1 && this.selectedIds.has(p.handle.id)) {
      for (const id of this.selectedIds) {
        if (id === p.handle.id) continue;
        const h = ctx.world.get(id);
        if (h) others.push(h);
      }
    }
    if (!this.groupController.begin(p.handle, others, seat)) return;

    this.carry = { handle: p.handle, active: false };
    this.velHistory.length = 0;
    this.cursorSpeed = 0;

    const t      = p.handle.get(TransformComponent);
    const meshX  = t?.object3d.position.x ?? 0;
    const meshY  = t?.object3d.position.y ?? 0;
    const meshZ  = t?.object3d.position.z ?? 0;

    this.draggedHalfExtentY = this.readHalfExtentY(p.handle);
    // Seed the hover state by lifting the entity HOVER_OFFSET above its
    // current pose. An entity at rest sits with its bottom on a surface, so
    // (meshY - halfExtentY) is that surface's Y; the steady-state hover puts
    // the entity center at `surfaceY + HOVER_OFFSET + halfExtentY`, which
    // simplifies to `meshY + HOVER_OFFSET`. Using the same delta here keeps
    // the pick-up lift visually consistent with the per-frame drag hover.
    this.holdY      = meshY + HOVER_OFFSET;
    this.targetY    = this.holdY;
    this.lastValidY = this.holdY;
    this.carryTarget.set(meshX, this.holdY, meshZ);
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
    const holdY  = deckY + HOVER_OFFSET;

    // Half-extent is filled in once the peeled card arrives — the deck's own
    // half-extent is the closest sensible default until then.
    this.draggedHalfExtentY = this.readHalfExtentY(p.handle);
    this.holdY      = holdY;
    this.targetY    = holdY;
    this.lastValidY = holdY;
    this.carryTarget.set(deckX, holdY, deckZ);
    this.velHistory.length = 0;
    this.cursorSpeed = 0;

    const peel: PendingPeel = {
      sourceId,
      pointerId:     p.pointerId,
      holdY,
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

  // Promote a `pendingEmpty` press to an in-flight marquee gesture. The
  // overlay attaches; per-frame onMove refreshes the rect + the candidate
  // set. Release commits via `onMarqueeCommit`.
  private beginMarquee(e: ToolPointerEvent, ctx: ToolContext): void {
    const pe = this.pendingEmpty;
    if (!pe) return;
    this.pendingEmpty = null;
    this.marqueeDrag = {
      startClientX: pe.startX,
      startClientY: pe.startY,
      modifier:     pe.modifier,
      candidates:   new Set(),
    };
    this.marqueeOverlay.attach();
    this.updateMarquee(e, ctx);
  }

  // Per-move marquee refresh: redraw the overlay and recompute the candidate
  // set against the current screen rect. Eligibility filter: skip the Table
  // singleton and any entity with `isContained === true` (deck cards, bag
  // items, hand-zone members). `heldBy` is not filtered — consistent with
  // shift-click; group-drag drops failed claims at `tryHold` time.
  private updateMarquee(e: ToolPointerEvent, ctx: ToolContext): void {
    const md = this.marqueeDrag;
    if (!md) return;
    const rect = ctx.element.getBoundingClientRect();
    const startLocal = { x: md.startClientX - rect.left, y: md.startClientY - rect.top };
    const endLocal   = { x: e.clientX        - rect.left, y: e.clientY        - rect.top };
    this.marqueeOverlay.update(startLocal, endLocal);

    const ndcRect = ndcRectFromScreen(
      { x: md.startClientX, y: md.startClientY },
      { x: e.clientX,       y: e.clientY       },
      rect,
    );
    const inputs: CandidateInput[] = [];
    ctx.world.forEach((h) => {
      if (h.id === TABLE_ENTITY_ID) return;
      if (h.entity.isContained) return;
      const t = h.get(TransformComponent);
      const obj = t?.object3d;
      if (!obj) return;
      inputs.push({ id: h.id, worldPosition: obj.position });
    });
    md.candidates = entitiesInMarquee(inputs, ndcRect, ctx.camera);
  }

  // Cursor angle around the centroid in the XZ (table) plane. Pointer ray
  // is projected onto a Y = pivot.y plane; returns null when the ray is
  // parallel to the plane (no hit).
  private cursorAngleAroundPivot(
    e:     ToolPointerEvent,
    pivot: [number, number, number],
  ): number | null {
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -pivot[1]);
    const hit = new THREE.Vector3();
    if (!e.ray.intersectPlane(plane, hit)) return null;
    const dx = hit.x - pivot[0];
    const dz = hit.z - pivot[2];
    return Math.atan2(dz, dx);
  }

  // Set up a multi-selection yaw drag. Claims every selected entity through
  // the GroupDragController (anchor = the first selected id, members = the
  // rest). Anchor-claim failure cancels the gesture; member failures shrink
  // the rotating subset, matching the slice-5 drag posture.
  private beginGroupRotate(
    pivot: [number, number, number],
    ctx:   ToolContext,
    seat:  SeatIndex,
    e:     ToolPointerEvent,
  ): boolean {
    if (this.selectedIds.size < 2) return false;
    const ids = [...this.selectedIds];
    const anchorHandle = ctx.world.get(ids[0]);
    if (!anchorHandle) return false;
    const others: EntityHandle[] = [];
    for (let i = 1; i < ids.length; i++) {
      const h = ctx.world.get(ids[i]);
      if (h) others.push(h);
    }
    if (!this.groupController.begin(anchorHandle, others, seat)) return false;
    const angle = this.cursorAngleAroundPivot(e, pivot);
    if (angle === null) {
      this.groupController.release();
      return false;
    }
    this.rotateDrag = { pivot, startAngle: angle };
    return true;
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

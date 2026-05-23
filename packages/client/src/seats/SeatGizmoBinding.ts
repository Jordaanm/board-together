// Drives a MoveGizmo against a synthetic THREE.Object3D positioned at the
// currently-edited seat, parallel to AxisGizmoAttachment. Pointer events are
// intercepted in the capture phase so the gizmo arms win priority over the
// ToolDispatcher (GrabTool, FlickTool, etc.) when active.
//
// Constraints:
//   • X / Z drag only — Y axis hits are ignored so seats stay at y = 0.
//   • Per-frame the synthetic handle is re-positioned from the live seats
//     array so remote / panel edits stay in sync without churn.
//   • While dragging, the new {x, z} pair is written through the supplied
//     onUpdateSeats callback every move event (matches the existing gizmo
//     cadence).

import * as THREE from 'three';
import { MoveGizmo, type GizmoAxis } from '../scene/MoveGizmo';
import { projectRayOntoAxis } from '../input/axisDrag';
import { type SeatState } from './SeatPoseState';

interface DragState {
  axis:    'x' | 'z';
  origin:  THREE.Vector3;  // handle position at drag start
  grabT:   number;         // axis-space coordinate of the cursor hit at start
  current: { x: number; z: number };
}

export class SeatGizmoBinding {
  readonly gizmo  = new MoveGizmo();
  private readonly handle = new THREE.Object3D();
  private editingIndex: number | null = null;
  private drag: DragState | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc       = new THREE.Vector2();
  // Set while we hold a pointer capture so the document-level move / up
  // listeners know which pointer to track.
  private capturedPointerId: number | null = null;

  constructor(
    private readonly scene:   THREE.Scene,
    private readonly camera:  THREE.PerspectiveCamera,
    private readonly element: HTMLElement,
    private readonly getCurrentSeats: () => readonly SeatState[] | null | undefined,
    private readonly onUpdateSeats:   (next: SeatState[]) => void,
  ) {
    this.scene.add(this.handle);
    // Capture phase so we get the event before ToolDispatcher's bubble-
    // phase listener and can stopImmediatePropagation when we intercept.
    this.element.addEventListener('pointerdown', this.onDown, true);
    this.element.addEventListener('pointermove', this.onMove, true);
    this.element.addEventListener('pointerup',   this.onUp,   true);
  }

  setEditingSeat(index: number | null): void {
    if (this.editingIndex === index) return;
    this.editingIndex = index;
    if (index === null) {
      this.cancelDrag();
      this.detachGizmo();
      return;
    }
    this.attachGizmo();
    this.syncHandleToSeat();
  }

  getEditingSeat(): number | null {
    return this.editingIndex;
  }

  // Per-frame — keeps the synthetic handle and gizmo aligned with the live
  // seat state. While dragging, the drag's authoritative `current` position
  // takes precedence so the handle doesn't snap back on a stale state read.
  update(): void {
    if (this.editingIndex === null) return;
    if (this.drag) {
      this.handle.position.set(this.drag.current.x, 0, this.drag.current.z);
    } else {
      this.syncHandleToSeat();
    }
    this.gizmo.update();
  }

  hasActiveDrag(): boolean {
    return this.drag !== null;
  }

  dispose(): void {
    this.cancelDrag();
    this.detachGizmo();
    this.element.removeEventListener('pointerdown', this.onDown, true);
    this.element.removeEventListener('pointermove', this.onMove, true);
    this.element.removeEventListener('pointerup',   this.onUp,   true);
    this.scene.remove(this.handle);
    this.gizmo.dispose();
  }

  // ── Internals ──────────────────────────────────────────────────────────
  private attachGizmo(): void {
    this.gizmo.attach(this.handle);
    if (!this.gizmo.group.parent) this.scene.add(this.gizmo.group);
  }

  private detachGizmo(): void {
    if (this.gizmo.group.parent) this.scene.remove(this.gizmo.group);
    this.gizmo.detach();
  }

  private syncHandleToSeat(): void {
    if (this.editingIndex === null) return;
    const seats = this.getCurrentSeats();
    const s = seats?.[this.editingIndex];
    if (!s) return;
    this.handle.position.set(s.x, 0, s.z);
  }

  private cancelDrag(): void {
    if (this.capturedPointerId !== null) {
      try { this.element.releasePointerCapture(this.capturedPointerId); }
      catch { /* pointer may already be released */ }
      this.capturedPointerId = null;
    }
    this.drag = null;
  }

  private onDown = (e: PointerEvent): void => {
    if (this.editingIndex === null) return;
    if (e.button !== 0) return;
    this.setRaycasterFromEvent(e);
    const axisName = this.gizmo.pickAxis(this.raycaster);
    if (!axisName) return;
    if (axisName === 'y') {
      // Y-axis arm — seats are pinned to y = 0. Swallow the click so it
      // doesn't fall through to the carry tool, but don't start a drag.
      e.stopImmediatePropagation();
      return;
    }
    const seats = this.getCurrentSeats();
    const s = seats?.[this.editingIndex];
    if (!s) return;
    const origin = new THREE.Vector3(s.x, 0, s.z);
    const t = projectRayOntoAxis(
      this.raycaster.ray, origin, axisVec(axisName), this.camera.position,
    );
    if (t === null) return;
    this.drag = {
      axis:    axisName,
      origin,
      grabT:   t,
      current: { x: s.x, z: s.z },
    };
    this.capturedPointerId = e.pointerId;
    this.element.setPointerCapture(e.pointerId);
    e.stopImmediatePropagation();
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.drag) return;
    this.setRaycasterFromEvent(e);
    const t = projectRayOntoAxis(
      this.raycaster.ray, this.drag.origin, axisVec(this.drag.axis), this.camera.position,
    );
    if (t === null) return;
    const delta = t - this.drag.grabT;
    const nextX = this.drag.axis === 'x' ? this.drag.origin.x + delta : this.drag.origin.x;
    const nextZ = this.drag.axis === 'z' ? this.drag.origin.z + delta : this.drag.origin.z;
    this.drag.current.x = nextX;
    this.drag.current.z = nextZ;

    const seats = this.getCurrentSeats();
    if (!seats || this.editingIndex === null) return;
    const cur = seats[this.editingIndex];
    if (!cur || (cur.x === nextX && cur.z === nextZ)) return;
    const next = seats.map((s, i) =>
      i === this.editingIndex ? { ...s, x: nextX, z: nextZ } : s,
    );
    this.onUpdateSeats(next);
    e.stopImmediatePropagation();
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.drag) return;
    if (e.button !== 0) return;
    this.cancelDrag();
    e.stopImmediatePropagation();
  };

  private setRaycasterFromEvent(e: PointerEvent): void {
    const rect = this.element.getBoundingClientRect();
    this.ndc.set(
      ((e.clientX - rect.left) / rect.width)  * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
  }
}

function axisVec(axis: GizmoAxis): THREE.Vector3 {
  if (axis === 'x') return new THREE.Vector3(1, 0, 0);
  if (axis === 'z') return new THREE.Vector3(0, 0, 1);
  return new THREE.Vector3(0, 1, 0);
}

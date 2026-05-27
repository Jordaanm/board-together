// AxisGizmoAttachment — wraps the move gizmo (single-selection translation
// arms) and the rotate gizmo (multi-selection centroid yaw ring) behind a
// unified ToolAttachment. GrabTool attaches/detaches it when its selection
// changes or its activation state flips.
//
// Single-select size 1 → translation arms attached to the entity's Object3D
// (current behavior, unchanged).
// Multi-select size > 1 → yaw ring attached to a virtual Object3D positioned
// at the group's centroid; centroid is frozen at attach time and lives until
// detach, so an in-flight rotation gesture doesn't drift.

import * as THREE from 'three';
import { type EntityHandle } from '../../entity/world';
import { TransformComponent } from '../../entity/components/TransformComponent';
import { TableComponent } from '../../entity/components/TableComponent';
import { type MoveGizmo } from '../../scene/MoveGizmo';
import { type RotateGizmo } from '../../scene/RotateGizmo';
import { groupCentroid } from '../groupCentroid';
import { type Pose } from '../GroupTransform';
import { type ToolAttachment, type ToolContext } from './types';

type AttachedMode = 'translate' | 'rotate' | null;

export class AxisGizmoAttachment implements ToolAttachment {
  private mode: AttachedMode = null;
  // Virtual target for the rotate gizmo — a bare Object3D whose position
  // equals the captured centroid. Stays in the scene only while the rotate
  // gizmo is attached.
  private readonly centroidTarget = new THREE.Object3D();

  constructor(
    private readonly scene:       THREE.Scene,
    private readonly moveGizmo:   MoveGizmo,
    private readonly rotateGizmo: RotateGizmo,
  ) {}

  // Single-entity attach. Used when the active selection has size 1 — falls
  // through to the existing translation gizmo on the entity's Object3D.
  attach(handle: EntityHandle, _ctx: ToolContext): void {
    this.detach();
    // Singleton Table is locked at world origin and uneditable through the
    // gizmo — selecting it from the editor row should not present a falsely-
    // draggable axis triad in the 3D scene.
    if (handle.entity.hasComponent(TableComponent)) return;
    const obj = handle.get(TransformComponent)?.object3d;
    if (!obj) return;
    this.moveGizmo.attach(obj);
    if (!this.moveGizmo.group.parent) this.scene.add(this.moveGizmo.group);
    this.mode = 'translate';
  }

  // Multi-selection attach. Positions the rotate gizmo at the centroid of
  // the given member poses; centroid is computed once here and stays fixed.
  attachGroup(memberPoses: readonly Pose[], _ctx: ToolContext): void {
    this.detach();
    if (memberPoses.length < 2) return;
    const [cx, cy, cz] = groupCentroid(memberPoses);
    this.centroidTarget.position.set(cx, cy, cz);
    if (!this.centroidTarget.parent) this.scene.add(this.centroidTarget);
    this.rotateGizmo.attach(this.centroidTarget);
    if (!this.rotateGizmo.group.parent) this.scene.add(this.rotateGizmo.group);
    this.mode = 'rotate';
  }

  detach(): void {
    if (this.mode === 'translate') {
      if (this.moveGizmo.group.parent) this.scene.remove(this.moveGizmo.group);
      this.moveGizmo.detach();
    } else if (this.mode === 'rotate') {
      if (this.rotateGizmo.group.parent) this.scene.remove(this.rotateGizmo.group);
      this.rotateGizmo.detach();
      if (this.centroidTarget.parent) this.scene.remove(this.centroidTarget);
    }
    this.mode = null;
  }

  update(_dt: number): void {
    if (this.mode === 'translate') this.moveGizmo.update();
    else if (this.mode === 'rotate') this.rotateGizmo.update();
  }

  isAttached(): boolean {
    return this.mode !== null;
  }

  // Read by GrabTool when deciding whether the pointer landed on the
  // rotation ring. Returns the centroid in world coords when the rotate
  // gizmo is currently attached; null otherwise.
  getRotateCentroid(): [number, number, number] | null {
    if (this.mode !== 'rotate') return null;
    const p = this.centroidTarget.position;
    return [p.x, p.y, p.z];
  }
}

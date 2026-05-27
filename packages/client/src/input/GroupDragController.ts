// GroupDragController — orchestrates a multi-entity rigid-body drag.
//
// Owns the per-entity HoldService claims and the GroupTransform offsets that
// keep members locked into formation around the anchor. The anchor itself is
// still moved by the GrabTool's existing carry path; this controller layers
// the members on top.
//
// Failure model:
//   * Anchor `tryHold` fails → caller aborts entirely. No members claimed,
//     no drag begins.
//   * Non-anchor `tryHold` fails → that member stays put, the drag proceeds
//     with the claimable subset. "Components decide effect" — same posture
//     used by the rest of the action layer.

import * as THREE from 'three';
import { type EntityHandle } from '../entity/world';
import { type SeatIndex } from '../seats/SeatLayout';
import { TransformComponent } from '../entity/components/TransformComponent';
import { PhysicsComponent } from '../entity/components/PhysicsComponent';
import { applyOffsets, captureOffsets, type MemberOffset, type Pose } from './GroupTransform';

export interface ActiveGroup {
  anchor:           EntityHandle;
  members:          EntityHandle[];
  offsets:          MemberOffset[];
  anchorStartPose:  Pose;
}

export class GroupDragController {
  private state: ActiveGroup | null = null;

  hasActive(): boolean { return this.state !== null; }

  // Attempt to begin a group drag. Returns `true` if the anchor was claimed.
  // Members that fail to claim are dropped from the drag silently. Anchor
  // failure aborts the entire drag — no members held, controller stays
  // inactive.
  begin(anchor: EntityHandle, others: readonly EntityHandle[], seat: SeatIndex): boolean {
    if (!anchor.tryHold(seat)) return false;

    const claimed: EntityHandle[] = [];
    for (const h of others) {
      if (h.id === anchor.id) continue;
      if (h.tryHold(seat)) claimed.push(h);
    }

    const anchorStartPose = poseOf(anchor);
    if (!anchorStartPose) {
      // Defensive: anchor lacks a TransformComponent. Nothing to drag.
      anchor.release();
      for (const h of claimed) h.release();
      return false;
    }

    const memberPoses = claimed
      .map(h => ({ id: h.id, pose: poseOf(h) }))
      .filter((m): m is { id: string; pose: Pose } => m.pose !== null);
    const offsets = captureOffsets(anchorStartPose, memberPoses);

    // Filter the claimed list down to those we have offsets for — any handle
    // that lost its transform between tryHold and pose-capture is released.
    const offsetIds = new Set(offsets.map(o => o.id));
    const final: EntityHandle[] = [];
    for (const h of claimed) {
      if (offsetIds.has(h.id)) final.push(h);
      else h.release();
    }

    this.state = { anchor, members: final, offsets, anchorStartPose };
    return true;
  }

  // Translation-only update — applies the new anchor world position to each
  // member, preserving the anchor's start rotation. Slice 5's drag does not
  // rotate the anchor.
  applyAnchorTranslation(x: number, y: number, z: number): void {
    const s = this.state;
    if (!s) return;
    const next = applyOffsets(
      { position: [x, y, z], rotation: s.anchorStartPose.rotation },
      s.offsets,
    );
    for (const m of s.members) {
      const p = next.get(m.id);
      if (!p) continue;
      m.setPosition(p.position[0], p.position[1], p.position[2]);
    }
  }

  // Pivoted rigid rotation around a frozen world-space pivot — slice 6's
  // centroid gizmo. `deltaQuat` is the total rotation applied to the group
  // since the gesture began (not an incremental delta), so the math is a
  // pure function of the starting poses and the current accumulated angle:
  // the centroid does not drift mid-gesture.
  //
  // Anchor + members are rotated; positions and orientations both transform.
  // Pose updates write directly through TransformComponent.setState and the
  // physics body so the change is visible the same frame. Guest replication
  // for rotation is not wired yet — the change applies locally on each peer
  // independently while the gesture runs; the host's next sync corrects.
  applyPivotedRotation(deltaQuat: THREE.Quaternion, pivot: [number, number, number]): void {
    const s = this.state;
    if (!s) return;

    // Anchor's new pose: position rotates around the pivot, rotation =
    // deltaQuat * startRotation.
    const newAnchorPos = rotatePointAround(s.anchorStartPose.position, pivot, deltaQuat);
    const startQuat = new THREE.Quaternion(
      s.anchorStartPose.rotation[0], s.anchorStartPose.rotation[1],
      s.anchorStartPose.rotation[2], s.anchorStartPose.rotation[3],
    );
    const newAnchorQuat = deltaQuat.clone().multiply(startQuat);
    const newAnchorPose: Pose = {
      position: newAnchorPos,
      rotation: [newAnchorQuat.x, newAnchorQuat.y, newAnchorQuat.z, newAnchorQuat.w],
    };

    writePose(s.anchor, newAnchorPose);
    const next = applyOffsets(newAnchorPose, s.offsets);
    for (const m of s.members) {
      const p = next.get(m.id);
      if (!p) continue;
      writePose(m, p);
    }
  }

  // Releases the anchor + all members with a shared throw velocity. Returns
  // the list of claimed members so the caller can apply per-entity follow-up
  // (e.g. drop-target tween). Anchor release is included.
  release(velocity?: { vx: number; vy: number; vz: number }): void {
    const s = this.state;
    if (!s) return;
    s.anchor.release(velocity);
    for (const m of s.members) m.release(velocity);
    this.state = null;
  }

  // For tests / introspection.
  current(): ActiveGroup | null { return this.state; }
}

function rotatePointAround(
  point: [number, number, number],
  pivot: [number, number, number],
  quat:  THREE.Quaternion,
): [number, number, number] {
  const v = new THREE.Vector3(
    point[0] - pivot[0],
    point[1] - pivot[1],
    point[2] - pivot[2],
  );
  v.applyQuaternion(quat);
  return [v.x + pivot[0], v.y + pivot[1], v.z + pivot[2]];
}

// Write a pose directly through TransformComponent + physics body. Bypasses
// the EntityHandle.setPosition path (which is host/guest-aware for
// translation only) because rotation has no equivalent wire RPC yet. Both
// peers run this locally during a rotate gesture and the host's regular
// transform sync reconciles after release.
function writePose(handle: EntityHandle, pose: Pose): void {
  const t = handle.get(TransformComponent);
  if (!t) return;
  t.setState({
    position: [pose.position[0], pose.position[1], pose.position[2]],
    rotation: [pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]],
    scale:    t.state.scale,
  });
  const phys = handle.get(PhysicsComponent);
  if (phys?.body) {
    phys.body.position.set(pose.position[0], pose.position[1], pose.position[2]);
    phys.body.quaternion.set(pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]);
  }
}

function poseOf(handle: EntityHandle): Pose | null {
  const t = handle.get(TransformComponent);
  if (!t) return null;
  // Read from the live Three.js object — drives correctly even when the
  // host's TransformComponent.state is mid-update (state is mutated after
  // the physics body, the object3d reflects render state). Falls back to
  // identity if either piece is missing (defensive against test fakes).
  const obj = t.object3d;
  if (!obj) return null;
  const p = obj.position;
  const q = obj.quaternion;
  return {
    position: [p.x, p.y, p.z],
    rotation: [q.x, q.y, q.z, q.w],
  };
}

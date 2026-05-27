// selectionLayout — pure resolver for the grid-layout hotkey.
//
// Given a selection, per-entity transforms / extents / capabilities, the
// active camera's forward+right vectors, and a column count, returns the
// post-layout pose for every entity that should be moved. The wiring layer
// (see SelectionLayoutHotkey) feeds these plans into the same per-entity
// transform-write path the rest of the app uses.
//
// Geometry is camera-yaw-only: forward and right are projected onto XZ so a
// top-down camera and a near-horizontal camera produce equally well-defined
// grids. Cell side fits the largest object plus a fixed padding. Row 0 sits
// farthest from the camera; the partial last row sits nearest.

import * as THREE from 'three';

export interface CameraAxes {
  // Camera's looking direction (world). Need not be in XZ plane.
  forward: [number, number, number];
  // Camera's right axis (world). Used as the row-direction reference; rows
  // recede in the perpendicular direction.
  right:   [number, number, number];
}

export interface EntityCapability {
  claimable:   boolean;
  movable:     boolean;
  extentKnown: boolean;
}

export interface EntityPose {
  position: [number, number, number];
  rotation: [number, number, number, number];   // quaternion (x, y, z, w)
}

export interface LayoutPlan {
  entityId: string;
  position: [number, number, number];
  rotation: [number, number, number, number];   // quaternion (x, y, z, w)
}

export interface ResolveSelectionLayoutInput {
  selection:     readonly string[];
  getTransform:  (id: string) => EntityPose | null;
  // Local-axis half-extents. Cell side derives from 2 × max half-extent.
  getExtent:     (id: string) => [number, number, number] | null;
  getCapability: (id: string) => EntityCapability;
  camera:        CameraAxes;
  columns:       number;
}

export const GRID_PADDING = 0.05;

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

export function resolveSelectionLayout(
  input: ResolveSelectionLayoutInput,
): LayoutPlan[] {
  if (input.columns < 1) return [];

  type Entry = { id: string; pose: EntityPose; extent: [number, number, number] };
  const entries: Entry[] = [];
  for (const id of input.selection) {
    const cap = input.getCapability(id);
    if (!cap.claimable || !cap.movable || !cap.extentKnown) continue;
    const pose   = input.getTransform(id);
    const extent = input.getExtent(id);
    if (!pose || !extent) continue;
    entries.push({ id, pose, extent });
  }
  if (entries.length < 2) return [];

  // Cell side = max full-extent across all filtered entities/axes + padding.
  let maxFullExtent = 0;
  for (const e of entries) {
    for (let i = 0; i < 3; i++) {
      const full = 2 * e.extent[i];
      if (full > maxFullExtent) maxFullExtent = full;
    }
  }
  const cellSide = maxFullExtent + GRID_PADDING;

  // Centroid in XZ.
  let cx = 0, cz = 0;
  for (const e of entries) {
    cx += e.pose.position[0];
    cz += e.pose.position[2];
  }
  cx /= entries.length;
  cz /= entries.length;

  // Grid axes from camera yaw. Project right onto XZ; derive forward by
  // rotating 90° CW around +Y so the two axes are always perpendicular and
  // forward points "into the screen" (away from camera).
  let rx = input.camera.right[0];
  let rz = input.camera.right[2];
  let rLen = Math.hypot(rx, rz);
  if (rLen < 1e-6) { rx = 1; rz = 0; rLen = 1; }
  rx /= rLen; rz /= rLen;
  const fx = rz;
  const fz = -rx;

  // Cell assignment: project entities along the grid axes (skipping the
  // camera-position term, which is constant across entries). Sort by the
  // forward dot descending (farther first) then the right dot ascending
  // (leftmost first), then fill row-major from cell [0,0].
  const sorted = entries.slice().sort((a, b) => {
    const aF = a.pose.position[0] * fx + a.pose.position[2] * fz;
    const bF = b.pose.position[0] * fx + b.pose.position[2] * fz;
    if (aF !== bF) return bF - aF;
    const aR = a.pose.position[0] * rx + a.pose.position[2] * rz;
    const bR = b.pose.position[0] * rx + b.pose.position[2] * rz;
    return aR - bR;
  });

  const cols   = input.columns;
  const rows   = Math.ceil(sorted.length / cols);
  const newYaw = Math.atan2(fx, fz);

  // Grid is centered on the centroid as if `cols × rows` cells were filled,
  // so a partial last row leaves empty cells nearest the camera (matching
  // the contract that the digit pressed is always the column count).
  const plans: LayoutPlan[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const colOffset = (col - (cols - 1) / 2) * cellSide;
    const rowOffset = ((rows - 1) / 2 - row) * cellSide;
    const x = cx + colOffset * rx + rowOffset * fx;
    const z = cz + colOffset * rz + rowOffset * fz;

    const ent = sorted[i];
    const y   = ent.extent[1];

    _q.set(ent.pose.rotation[0], ent.pose.rotation[1], ent.pose.rotation[2], ent.pose.rotation[3]);
    _e.setFromQuaternion(_q, 'YXZ');
    _e.y = newYaw;
    _q.setFromEuler(_e);

    plans.push({
      entityId: ent.id,
      position: [x, y, z],
      rotation: [_q.x, _q.y, _q.z, _q.w],
    });
  }
  return plans;
}

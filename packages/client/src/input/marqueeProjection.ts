// marqueeProjection — pure helpers for the marquee inclusion test.
//
// Projects each candidate's world origin through the active camera into NDC
// and tests rectangle containment. Behind-camera entities (projected z
// outside [-1, 1]) are excluded even if their projected x/y land inside the
// rect — the perspective-divide flips coordinates for negative-w points and
// would otherwise yield false positives.

import * as THREE from 'three';

export interface CandidateInput {
  id:            string;
  worldPosition: THREE.Vector3;
}

// Axis-aligned rectangle in NDC ([-1, 1] on each axis). Caller is expected
// to have normalised inverted drags (so x0 <= x1, y0 <= y1).
export interface NdcRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// Build an NDC-space rectangle from two screen-space corner points and the
// canvas's bounding rect. Normalises so the returned rect always has
// x0 <= x1 and y0 <= y1 regardless of drag direction. NDC y axis is flipped
// relative to client y, so the conversion bakes that in.
export function ndcRectFromScreen(
  a:    { x: number; y: number },
  b:    { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number },
): NdcRect {
  const ax = ((a.x - rect.left) / rect.width)  * 2 - 1;
  const ay = -((a.y - rect.top) / rect.height) * 2 + 1;
  const bx = ((b.x - rect.left) / rect.width)  * 2 - 1;
  const by = -((b.y - rect.top) / rect.height) * 2 + 1;
  return {
    x0: Math.min(ax, bx),
    x1: Math.max(ax, bx),
    y0: Math.min(ay, by),
    y1: Math.max(ay, by),
  };
}

// Reusable scratch — called every animation frame during a marquee.
const _v = new THREE.Vector3();

export function entitiesInMarquee(
  candidates: Iterable<CandidateInput>,
  rect:       NdcRect,
  camera:     THREE.Camera,
): Set<string> {
  const out = new Set<string>();
  for (const { id, worldPosition } of candidates) {
    _v.copy(worldPosition).project(camera);
    // Frustum z-cull first — Vector3.project does the perspective divide,
    // so a point behind the camera lands with z outside [-1, 1] (typically
    // < -1 after the divide). Drop it before the x/y test.
    if (_v.z < -1 || _v.z > 1) continue;
    if (_v.x < rect.x0 || _v.x > rect.x1) continue;
    if (_v.y < rect.y0 || _v.y > rect.y1) continue;
    out.add(id);
  }
  return out;
}

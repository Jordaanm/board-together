// groupCentroid — pure helper. Returns the mean of the given entity origins.
// Used by AxisGizmoAttachment to position the centroid gizmo for a multi-
// selection. PRD requires the centroid to be frozen at attach time; this
// function is called once per gesture, not per frame.

import { type Pose } from './GroupTransform';

export function groupCentroid(poses: readonly Pose[]): [number, number, number] {
  if (poses.length === 0) return [0, 0, 0];
  let sx = 0, sy = 0, sz = 0;
  for (const p of poses) {
    sx += p.position[0];
    sy += p.position[1];
    sz += p.position[2];
  }
  return [sx / poses.length, sy / poses.length, sz / poses.length];
}

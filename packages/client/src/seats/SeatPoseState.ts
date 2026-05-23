// Pure conversion helpers between stored seat state ({x, z, yaw}) and the
// legacy `SeatPose` shape ({position, facing}). No THREE / DOM / network deps —
// safe to import from components, UI, and tests alike.
//
// Yaw convention: yaw = 0 → facing -Z (from +Z edge toward table centre).
// Positive yaw rotates CCW viewed from above.

import { computeSeatLayout, type SeatPose } from './SeatLayout';

export interface SeatState {
  x:   number;
  z:   number;
  yaw: number;  // radians
}

export function seatPoseFromState(s: SeatState): SeatPose {
  return {
    position: { x: s.x, y: 0, z: s.z },
    facing:   { x: -Math.sin(s.yaw), y: 0, z: -Math.cos(s.yaw) },
  };
}

export function stateFromPose(p: SeatPose): SeatState {
  return {
    x:   p.position.x,
    z:   p.position.z,
    yaw: Math.atan2(-p.facing.x, -p.facing.z),
  };
}

export function defaultSeatStates(bounds: { halfWidth: number; halfDepth: number }): SeatState[] {
  return computeSeatLayout(bounds).map(stateFromPose);
}

// Wrap a degree value into [-180, 180]. Both 180 and -180 normalize to 180.
export function normalizeYawDegrees(deg: number): number {
  let d = ((deg % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

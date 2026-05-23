// Pure orbit-math helper for the camera-snap-on-seat behaviour. Given a seat
// pose and the local camera's current radius / phi, returns the orbit target
// + theta that places the camera behind the seat looking toward the table
// centre. radius / phi are preserved by the caller (CameraController mutation
// happens at the call site).

import { type SeatPose } from './SeatLayout';

export interface OrbitSnap {
  theta:  number;
  target: { x: number; y: number; z: number };
}

export function computeOrbitForSeat(
  seatPose: SeatPose,
  _radius:  number,
  _phi:     number,
): OrbitSnap {
  const { x, z } = seatPose.position;
  // CameraController places the camera at target + radius * (sin θ, *, cos θ)
  // on the XZ plane. We want camera_xz to lie on the line from the origin
  // through the seat, on the far side from the table centre — i.e. direction
  // (x, z) / |(x, z)|. That requires θ = atan2(x, z).
  // Edge case: seat sitting exactly at the origin has no defined "behind"
  // direction; keep θ at 0 so we don't NaN-out the camera.
  const r = Math.hypot(x, z);
  const theta = r < 1e-6 ? 0 : Math.atan2(x, z);
  return { theta, target: { x: 0, y: 0, z: 0 } };
}

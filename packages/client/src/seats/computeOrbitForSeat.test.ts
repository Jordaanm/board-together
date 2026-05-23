import { describe, test, expect } from 'vitest';
import { computeOrbitForSeat } from './computeOrbitForSeat';
import { computeSeatLayout } from './SeatLayout';
import { seatPoseFromState, stateFromPose } from './SeatPoseState';

const DEFAULT_BOUNDS = { halfWidth: 6, halfDepth: 4 };

// CameraController places camera at target + r * (sin θ, *, cos θ) on XZ.
// For a seat at (x, z), "behind" the seat (on the far side from origin) is
// in the direction (x, z) / ||(x, z)||. So:
//   sin θ = x / ||(x, z)||
//   cos θ = z / ||(x, z)||
function expectedTheta(x: number, z: number): number {
  const r = Math.hypot(x, z);
  return r < 1e-6 ? 0 : Math.atan2(x, z);
}

describe('computeOrbitForSeat — all 8 default seats', () => {
  const poses = computeSeatLayout(DEFAULT_BOUNDS);

  test.each(poses.map((p, i) => [i, p] as const))(
    'seat %i — theta places camera on far side of origin from seat',
    (_i, pose) => {
      const { theta, target } = computeOrbitForSeat(pose, 14, Math.PI / 3.5);
      expect(target).toEqual({ x: 0, y: 0, z: 0 });
      const expected = expectedTheta(pose.position.x, pose.position.z);
      expect(theta).toBeCloseTo(expected, 10);
      // Verify the resulting camera XZ direction (sin θ, cos θ) matches the
      // unit vector from origin toward the seat.
      const r = Math.hypot(pose.position.x, pose.position.z);
      expect(Math.sin(theta)).toBeCloseTo(pose.position.x / r, 10);
      expect(Math.cos(theta)).toBeCloseTo(pose.position.z / r, 10);
    },
  );
});

describe('computeOrbitForSeat — non-default pose', () => {
  test('arbitrary off-axis seat at (2.5, 0, -3.7) facing centre', () => {
    const pose = seatPoseFromState(stateFromPose({
      position: { x: 2.5, y: 0, z: -3.7 },
      facing:   { x: -2.5 / Math.hypot(2.5, 3.7), y: 0, z: 3.7 / Math.hypot(2.5, 3.7) },
    }));
    const { theta, target } = computeOrbitForSeat(pose, 10, 1);
    expect(target).toEqual({ x: 0, y: 0, z: 0 });
    expect(theta).toBeCloseTo(Math.atan2(2.5, -3.7), 10);
  });

  test('seat at origin returns theta = 0 (no NaN)', () => {
    const pose = { position: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: -1 } };
    const { theta, target } = computeOrbitForSeat(pose, 14, 1);
    expect(theta).toBe(0);
    expect(target).toEqual({ x: 0, y: 0, z: 0 });
  });
});

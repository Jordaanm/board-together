import { describe, test, expect } from 'vitest';
import {
  seatPoseFromState,
  stateFromPose,
  defaultSeatStates,
  normalizeYawDegrees,
} from './SeatPoseState';
import { computeSeatLayout } from './SeatLayout';

const DEFAULT_BOUNDS = { halfWidth: 6, halfDepth: 4 };

describe('seatPoseFromState / stateFromPose — round-trip', () => {
  test('round-trips the 8 canonical default seats', () => {
    const poses  = computeSeatLayout(DEFAULT_BOUNDS);
    const states = poses.map(stateFromPose);
    const back   = states.map(seatPoseFromState);
    for (let i = 0; i < 8; i++) {
      expect(back[i].position.x).toBeCloseTo(poses[i].position.x, 10);
      expect(back[i].position.y).toBeCloseTo(poses[i].position.y, 10);
      expect(back[i].position.z).toBeCloseTo(poses[i].position.z, 10);
      expect(back[i].facing.x).toBeCloseTo(poses[i].facing.x, 10);
      expect(back[i].facing.y).toBeCloseTo(poses[i].facing.y, 10);
      expect(back[i].facing.z).toBeCloseTo(poses[i].facing.z, 10);
    }
  });

  test('yaw = 0 produces facing -Z', () => {
    const p = seatPoseFromState({ x: 0, z: 0, yaw: 0 });
    expect(p.facing.x).toBeCloseTo(0, 10);
    expect(p.facing.z).toBeCloseTo(-1, 10);
  });

  test('yaw = +90° rotates facing CCW (-Z → -X)', () => {
    const p = seatPoseFromState({ x: 0, z: 0, yaw: Math.PI / 2 });
    expect(p.facing.x).toBeCloseTo(-1, 10);
    expect(p.facing.z).toBeCloseTo(0, 10);
  });
});

describe('defaultSeatStates — matches computeSeatLayout', () => {
  test('default rect bounds (6, 4)', () => {
    const states = defaultSeatStates(DEFAULT_BOUNDS);
    const poses  = computeSeatLayout(DEFAULT_BOUNDS);
    expect(states).toHaveLength(8);
    for (let i = 0; i < 8; i++) {
      expect(states[i].x).toBeCloseTo(poses[i].position.x, 10);
      expect(states[i].z).toBeCloseTo(poses[i].position.z, 10);
      const back = seatPoseFromState(states[i]);
      expect(back.facing.x).toBeCloseTo(poses[i].facing.x, 10);
      expect(back.facing.z).toBeCloseTo(poses[i].facing.z, 10);
    }
  });

  test('scaled bounds (12, 8)', () => {
    const states = defaultSeatStates({ halfWidth: 12, halfDepth: 8 });
    const poses  = computeSeatLayout({ halfWidth: 12, halfDepth: 8 });
    for (let i = 0; i < 8; i++) {
      expect(states[i].x).toBeCloseTo(poses[i].position.x, 10);
      expect(states[i].z).toBeCloseTo(poses[i].position.z, 10);
    }
  });
});

describe('normalizeYawDegrees', () => {
  test.each([
    [0,    0],
    [45,   45],
    [-45, -45],
    [180,  180],
    [-180, 180],
    [360,  0],
    [720,  0],
    [-720, 0],
    [181, -179],
    [-181, 179],
    [540,  180],
  ])('normalizeYawDegrees(%d) = %d', (input, expected) => {
    expect(normalizeYawDegrees(input)).toBe(expected);
  });
});

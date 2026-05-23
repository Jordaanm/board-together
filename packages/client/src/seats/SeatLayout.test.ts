import { describe, test, expect } from 'vitest';
import {
  computeSeatLayout,
  SEAT_COLOURS,
  type SeatIndex,
  type SeatPose,
} from './SeatLayout';

const ALL_INDICES: SeatIndex[] = [0, 1, 2, 3, 4, 5, 6, 7];

const DEFAULT_BOUNDS = { halfWidth: 6, halfDepth: 4 };

describe('SEAT_COLOURS', () => {
  test('has 8 entries in fixed order', () => {
    expect(SEAT_COLOURS).toEqual(
      ['white', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'],
    );
  });
});

describe('computeSeatLayout — default rectangle bounds', () => {
  // Table 12 × 8 → bounds {halfWidth: 6, halfDepth: 4}. CCW from front-right.
  const expected: SeatPose[] = [
    { position: { x:  3, y: 0, z:  4 }, facing: { x:  0, y: 0, z: -1 } },
    { position: { x:  0, y: 0, z:  4 }, facing: { x:  0, y: 0, z: -1 } },
    { position: { x: -3, y: 0, z:  4 }, facing: { x:  0, y: 0, z: -1 } },
    { position: { x: -6, y: 0, z:  0 }, facing: { x:  1, y: 0, z:  0 } },
    { position: { x: -3, y: 0, z: -4 }, facing: { x:  0, y: 0, z:  1 } },
    { position: { x:  0, y: 0, z: -4 }, facing: { x:  0, y: 0, z:  1 } },
    { position: { x:  3, y: 0, z: -4 }, facing: { x:  0, y: 0, z:  1 } },
    { position: { x:  6, y: 0, z:  0 }, facing: { x: -1, y: 0, z:  0 } },
  ];

  test('returns 8 seat poses', () => {
    expect(computeSeatLayout(DEFAULT_BOUNDS)).toHaveLength(8);
  });

  test.each(ALL_INDICES.map(i => [i, expected[i]] as const))('seat %i', (i, pose) => {
    expect(computeSeatLayout(DEFAULT_BOUNDS)[i]).toEqual(pose);
  });
});

describe('computeSeatLayout — scales with bounds', () => {
  test('doubling bounds doubles seat distances from origin', () => {
    const small = computeSeatLayout({ halfWidth: 3, halfDepth: 2 });
    const big   = computeSeatLayout({ halfWidth: 6, halfDepth: 4 });
    for (const i of ALL_INDICES) {
      expect(big[i].position.x).toBeCloseTo(small[i].position.x * 2, 10);
      expect(big[i].position.z).toBeCloseTo(small[i].position.z * 2, 10);
      expect(big[i].facing).toEqual(small[i].facing);
    }
  });
});

describe('computeSeatLayout — invariants', () => {
  test('every facing is a unit vector', () => {
    for (const i of ALL_INDICES) {
      const { facing } = computeSeatLayout(DEFAULT_BOUNDS)[i];
      const len = Math.hypot(facing.x, facing.y, facing.z);
      expect(len).toBeCloseTo(1, 10);
    }
  });

  test('every facing has a positive component toward the table centre', () => {
    for (const i of ALL_INDICES) {
      const { position, facing } = computeSeatLayout(DEFAULT_BOUNDS)[i];
      const dot = facing.x * -position.x + facing.y * -position.y + facing.z * -position.z;
      expect(dot).toBeGreaterThan(0);
    }
  });
});

import { describe, test, expect } from 'vitest';
import { groupCentroid } from './groupCentroid';
import { type Pose } from './GroupTransform';

const Q: [number, number, number, number] = [0, 0, 0, 1];

function pose(x: number, y: number, z: number): Pose {
  return { position: [x, y, z], rotation: Q };
}

describe('groupCentroid', () => {
  test('empty input returns origin', () => {
    expect(groupCentroid([])).toEqual([0, 0, 0]);
  });

  test('single pose returns that pose', () => {
    expect(groupCentroid([pose(3, 1, -2)])).toEqual([3, 1, -2]);
  });

  test('mean of three corner positions', () => {
    const out = groupCentroid([pose(0, 0, 0), pose(6, 0, 0), pose(0, 0, 6)]);
    expect(out[0]).toBeCloseTo(2);
    expect(out[1]).toBeCloseTo(0);
    expect(out[2]).toBeCloseTo(2);
  });
});

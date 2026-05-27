import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import { captureOffsets, applyOffsets, type Pose } from './GroupTransform';

const IDENTITY_QUAT: [number, number, number, number] = [0, 0, 0, 1];

function pose(x: number, y: number, z: number, quat: [number, number, number, number] = IDENTITY_QUAT): Pose {
  return { position: [x, y, z], rotation: quat };
}

describe('GroupTransform — capture / apply roundtrip', () => {
  test('pure translation preserves member offsets', () => {
    const anchor = pose(0, 0, 0);
    const members = [
      { id: 'a', pose: pose(1, 0, 0) },
      { id: 'b', pose: pose(0, 0, 1) },
      { id: 'c', pose: pose(2, 0, -3) },
    ];
    const offsets = captureOffsets(anchor, members);

    const out = applyOffsets(pose(5, 0, 5), offsets);
    const a = out.get('a')!;
    const b = out.get('b')!;
    const c = out.get('c')!;
    expect(a.position[0]).toBeCloseTo(6);
    expect(a.position[2]).toBeCloseTo(5);
    expect(b.position[0]).toBeCloseTo(5);
    expect(b.position[2]).toBeCloseTo(6);
    expect(c.position[0]).toBeCloseTo(7);
    expect(c.position[2]).toBeCloseTo(2);
  });

  test('rotation of anchor rotates member positions around the new anchor', () => {
    // Anchor at origin, identity rotation. Member at (1, 0, 0).
    const anchor = pose(0, 0, 0);
    const members = [{ id: 'a', pose: pose(1, 0, 0) }];
    const offsets = captureOffsets(anchor, members);

    // Rotate anchor 90° about Y, still at origin.
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const out = applyOffsets(pose(0, 0, 0, [q.x, q.y, q.z, q.w]), offsets);
    const a = out.get('a')!;
    // (1,0,0) rotated 90° about Y → roughly (0,0,-1).
    expect(a.position[0]).toBeCloseTo(0);
    expect(a.position[2]).toBeCloseTo(-1);
  });

  test('identity-anchor roundtrip restores starting member poses', () => {
    const anchor = pose(2, 0, 3);
    const members = [
      { id: 'a', pose: pose(5, 1, 4) },
      { id: 'b', pose: pose(2, 0, 7) },
    ];
    const offsets = captureOffsets(anchor, members);
    const out = applyOffsets(anchor, offsets);
    for (const m of members) {
      const got = out.get(m.id)!;
      expect(got.position[0]).toBeCloseTo(m.pose.position[0]);
      expect(got.position[1]).toBeCloseTo(m.pose.position[1]);
      expect(got.position[2]).toBeCloseTo(m.pose.position[2]);
    }
  });

  test('member rotation rotates with the anchor', () => {
    // Anchor identity. Member at (1,0,0) with its own 90° yaw.
    const memberQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const anchor = pose(0, 0, 0);
    const members = [
      { id: 'a', pose: pose(1, 0, 0, [memberQuat.x, memberQuat.y, memberQuat.z, memberQuat.w]) },
    ];
    const offsets = captureOffsets(anchor, members);

    // Rotate anchor another 90° about Y.
    const anchorQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const out = applyOffsets(pose(0, 0, 0, [anchorQ.x, anchorQ.y, anchorQ.z, anchorQ.w]), offsets);
    const got = out.get('a')!;
    // Member position rotates to (0,0,-1). Member's world quat is anchorQ * memberQ
    // = 180° about Y.
    expect(got.position[0]).toBeCloseTo(0);
    expect(got.position[2]).toBeCloseTo(-1);
    const r = new THREE.Quaternion(got.rotation[0], got.rotation[1], got.rotation[2], got.rotation[3]);
    const expected = anchorQ.clone().multiply(memberQuat);
    expect(r.x).toBeCloseTo(expected.x);
    expect(r.y).toBeCloseTo(expected.y);
    expect(r.z).toBeCloseTo(expected.z);
    expect(r.w).toBeCloseTo(expected.w);
  });
});

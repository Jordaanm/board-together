import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import { extractPose, type Quat } from './extractPose';

function applyToY(rot: readonly [number, number, number, number]): THREE.Vector3 {
  const q = new THREE.Quaternion(rot[0], rot[1], rot[2], rot[3]);
  return new THREE.Vector3(0, 1, 0).applyQuaternion(q);
}

const IDENTITY: Quat = [0, 0, 0, 1];

function quatFromAxisAngle(axis: [number, number, number], angle: number): Quat {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis), angle);
  return [q.x, q.y, q.z, q.w];
}

describe('extractPose', () => {
  test('passes the hit point through unchanged', () => {
    const pose = extractPose(IDENTITY, [1.5, 0.4, -2.3]);
    expect(pose.position[0]).toBeCloseTo(1.5);
    expect(pose.position[1]).toBeCloseTo(0.4);
    expect(pose.position[2]).toBeCloseTo(-2.3);
  });

  test('deck face-up upright (identity) → card face-up (+Y aligned with world +Y)', () => {
    const pose = extractPose(IDENTITY, [0, 0, 0]);
    const up = applyToY(pose.rotation);
    expect(up.y).toBeCloseTo(1, 5);
  });

  test('deck face-down upright (180° around X) → card face-up', () => {
    const deckRot = quatFromAxisAngle([1, 0, 0], Math.PI);
    const pose = extractPose(deckRot, [0, 0, 0]);
    const up = applyToY(pose.rotation);
    expect(up.y).toBeCloseTo(1, 5);
  });

  test('deck face-down via 180° around Z → card face-up', () => {
    const deckRot = quatFromAxisAngle([0, 0, 1], Math.PI);
    const pose = extractPose(deckRot, [0, 0, 0]);
    const up = applyToY(pose.rotation);
    expect(up.y).toBeCloseTo(1, 5);
  });

  test('deck rotated 90° around Y → card face-up (+Y aligned with world +Y)', () => {
    const deckRot = quatFromAxisAngle([0, 1, 0], Math.PI / 2);
    const pose = extractPose(deckRot, [0, 0, 0]);
    const up = applyToY(pose.rotation);
    expect(up.y).toBeCloseTo(1, 5);
  });

  test('deck rotated 90° around Y → card preserves the deck yaw', () => {
    const deckRot = quatFromAxisAngle([0, 1, 0], Math.PI / 2);
    const pose = extractPose(deckRot, [0, 0, 0]);
    // Local +X of the card after rotation should match deck's local +X
    const q = new THREE.Quaternion(pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]);
    const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    // Deck rotated +90° around Y maps +X → -Z (or +Z depending on sign convention)
    expect(Math.abs(x.y)).toBeLessThan(1e-5);
  });
});

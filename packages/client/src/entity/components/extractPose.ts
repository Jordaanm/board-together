// Pose computer for inspect → extract. Issue #1 of
// planning/issues--deck-inspect.md.
//
// Given the deck's rotation and a world-space hit point, return a pose for an
// extracted card so it lands face-up at the cursor regardless of how the deck
// is oriented. "Face-up" means the card's local +Y (which carries the `face`
// material slot, per the `prim:card` build) aligns with world +Y.
//
// The card and the deck share the same material convention: +Y = face,
// -Y = back. So if the deck's local +Y is already pointing up, the card can
// inherit the deck's rotation directly. If it's pointing down (face-down
// deck), we multiply by a 180° rotation about local X to bring the face up.

import * as THREE from 'three';

export type Quat = readonly [number, number, number, number];
export type Vec3 = readonly [number, number, number];

export interface ExtractPose {
  position: [number, number, number];
  rotation: [number, number, number, number];
}

const _q   = new THREE.Quaternion();
const _up  = new THREE.Vector3();
const FLIP_X = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);

export function extractPose(deckRotation: Quat, hitPoint: Vec3): ExtractPose {
  _q.set(deckRotation[0], deckRotation[1], deckRotation[2], deckRotation[3]);
  _up.set(0, 1, 0).applyQuaternion(_q);
  // Deck's local +Y points down → flip 180° around local X to bring the
  // card's face back to world +Y.
  if (_up.y < 0) _q.multiply(FLIP_X);
  return {
    position: [hitPoint[0], hitPoint[1], hitPoint[2]],
    rotation: [_q.x, _q.y, _q.z, _q.w],
  };
}

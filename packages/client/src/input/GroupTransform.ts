// GroupTransform — pure math for moving / rotating a group of entities
// as a rigid body relative to an anchor.
//
// `captureOffsets` records each member's pose in the anchor's local frame at
// drag-start. `applyOffsets` reapplies those offsets given a new anchor pose,
// returning the resulting world poses. Same module drives slice #5 (drag)
// and slice #6 (centroid rotate) — drag holds the anchor's rotation fixed,
// rotate moves the anchor's rotation around a centroid pivot.

import * as THREE from 'three';

export interface Pose {
  position: [number, number, number];
  rotation: [number, number, number, number];  // quaternion (x, y, z, w)
}

export interface MemberOffset {
  id:        string;
  localPos:  [number, number, number];          // offset in anchor-local frame
  localQuat: [number, number, number, number];  // member rotation in anchor-local frame
}

export interface Member {
  id:   string;
  pose: Pose;
}

// Reusable scratch — these helpers run per-frame during a drag.
const _aPos      = new THREE.Vector3();
const _aQuat     = new THREE.Quaternion();
const _aQuatInv  = new THREE.Quaternion();
const _mPos      = new THREE.Vector3();
const _mQuat     = new THREE.Quaternion();
const _localPos  = new THREE.Vector3();
const _localQuat = new THREE.Quaternion();
const _outQuat   = new THREE.Quaternion();

export function captureOffsets(anchor: Pose, members: readonly Member[]): MemberOffset[] {
  _aPos.set(anchor.position[0], anchor.position[1], anchor.position[2]);
  _aQuat.set(anchor.rotation[0], anchor.rotation[1], anchor.rotation[2], anchor.rotation[3]);
  _aQuatInv.copy(_aQuat).invert();
  return members.map(({ id, pose }) => {
    _mPos.set(pose.position[0], pose.position[1], pose.position[2]);
    _mQuat.set(pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]);
    _localPos.copy(_mPos).sub(_aPos).applyQuaternion(_aQuatInv);
    _localQuat.copy(_aQuatInv).multiply(_mQuat);
    return {
      id,
      localPos:  [_localPos.x, _localPos.y, _localPos.z],
      localQuat: [_localQuat.x, _localQuat.y, _localQuat.z, _localQuat.w],
    };
  });
}

export function applyOffsets(newAnchor: Pose, offsets: readonly MemberOffset[]): Map<string, Pose> {
  _aPos.set(newAnchor.position[0], newAnchor.position[1], newAnchor.position[2]);
  _aQuat.set(newAnchor.rotation[0], newAnchor.rotation[1], newAnchor.rotation[2], newAnchor.rotation[3]);
  const out = new Map<string, Pose>();
  for (const offset of offsets) {
    _localPos.set(offset.localPos[0], offset.localPos[1], offset.localPos[2]);
    _localPos.applyQuaternion(_aQuat).add(_aPos);
    _localQuat.set(offset.localQuat[0], offset.localQuat[1], offset.localQuat[2], offset.localQuat[3]);
    _outQuat.copy(_aQuat).multiply(_localQuat);
    out.set(offset.id, {
      position: [_localPos.x, _localPos.y, _localPos.z],
      rotation: [_outQuat.x, _outQuat.y, _outQuat.z, _outQuat.w],
    });
  }
  return out;
}

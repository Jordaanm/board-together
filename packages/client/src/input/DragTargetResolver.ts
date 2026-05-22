// Resolves the world-space target pose for a dragged entity each frame.
// Issue #2 of planning/issues--drag-refactor.md.
//
// Pure-ish: given a raycaster, a pre-filtered list of candidate meshes
// (caller has already removed the dragged entity and any held entities),
// the dragged entity's half-extent in Y, the hover offset, and a fallback
// plane Y, returns a HoverResult.
//
// `bare`: ray hit something — entity hovers at `surfaceY + hoverOffset +
// halfExtentY`, X/Z follows cursor's hit XZ 1:1.
// `none`: ray missed everything — entity stays at `fallbackY` and X/Z
// follows the cursor projected onto the horizontal plane at that Y.
//
// Slices #3-#6 will extend HoverResult with `merge` and `snap-point` kinds.

import * as THREE from 'three';

export interface BareHover {
  kind:     'bare';
  // World-space target position with hoverOffset + halfExtentY already added.
  position: THREE.Vector3;
  // Raw raycast hit Y (the surface the object hovers above).
  surfaceY: number;
}

export interface NoHover {
  kind:      'none';
  // Cursor projected onto the horizontal plane at fallbackY.
  position:  THREE.Vector3;
  fallbackY: number;
}

export type HoverResult = BareHover | NoHover;

export interface ResolverInput {
  raycaster:          THREE.Raycaster;
  // Caller filters: excludes the dragged entity and every held entity.
  candidateMeshes:    readonly THREE.Object3D[];
  draggedHalfExtentY: number;
  hoverOffset:        number;
  // Last valid surface Y. Used as the horizontal-plane Y when the ray misses.
  fallbackY:          number;
}

// Scratch plane reused across calls — its normal/constant are set per call.
const fallbackPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

export function resolveDragTarget(input: ResolverInput): HoverResult {
  const hits = input.candidateMeshes.length > 0
    ? input.raycaster.intersectObjects(input.candidateMeshes as THREE.Object3D[], true)
    : [];
  if (hits.length > 0) {
    const hit = hits[0];
    const targetY = hit.point.y + input.hoverOffset + input.draggedHalfExtentY;
    return {
      kind:     'bare',
      position: new THREE.Vector3(hit.point.x, targetY, hit.point.z),
      surfaceY: hit.point.y,
    };
  }
  // Project ray onto horizontal plane at fallbackY. A plane with normal
  // (0,1,0) and constant `-fallbackY` passes through y=fallbackY.
  fallbackPlane.normal.set(0, 1, 0);
  fallbackPlane.constant = -input.fallbackY;
  const out = new THREE.Vector3();
  if (input.raycaster.ray.intersectPlane(fallbackPlane, out)) {
    return { kind: 'none', position: out, fallbackY: input.fallbackY };
  }
  // Degenerate fallback (ray parallel to plane): keep cursor origin XZ at
  // fallback Y. Better than NaN.
  return {
    kind:      'none',
    position:  new THREE.Vector3(input.raycaster.ray.origin.x, input.fallbackY, input.raycaster.ray.origin.z),
    fallbackY: input.fallbackY,
  };
}

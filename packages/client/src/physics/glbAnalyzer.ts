// Pure GLB → vertex extractor for the hull builder.
//
// v1 (this slice): walks the model root and returns every mesh vertex baked
//   through its node's world transform.
// v2 (issue #2): when a node named exactly `_collision` exists, returns only
//   that node's geometry baked through its world transform.

import * as THREE from 'three';

export function extractHullSource(root: THREE.Object3D): THREE.Vector3[] {
  // updateMatrixWorld guarantees every descendant's matrixWorld is current
  // even when the root has never been parented or rendered.
  root.updateMatrixWorld(true);

  const out: THREE.Vector3[] = [];
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    const geom = mesh.geometry;
    if (!geom || !(geom as THREE.BufferGeometry).attributes) return;
    const pos = (geom as THREE.BufferGeometry).attributes.position as THREE.BufferAttribute | undefined;
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(node.matrixWorld);
      out.push(v);
    }
  });
  return out;
}

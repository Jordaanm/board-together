// Pure GLB → vertex extractor for the hull builder.
//
// When the scene contains a node named exactly `_collision` (literal,
// case-sensitive), only that node's geometry is returned so asset authors
// can supply a low-poly collider decoupled from the visual mesh. Without
// that node, every mesh in the scene is merged through node world
// transforms — the default behaviour.

import * as THREE from 'three';

export const COLLISION_NODE_NAME = '_collision';

export function extractHullSource(root: THREE.Object3D): THREE.Vector3[] {
  // updateMatrixWorld guarantees every descendant's matrixWorld is current
  // even when the root has never been parented or rendered.
  root.updateMatrixWorld(true);

  const collision = findCollisionNode(root);
  const source: THREE.Object3D = collision ?? root;

  const out: THREE.Vector3[] = [];
  source.traverse((node) => {
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

// Walks the scene looking for a node whose `.name` exactly matches
// `_collision`. Returns null if absent. Match is case-sensitive and
// rejects suffixed variants (`_collision_temp`) so authors aren't
// surprised by partial matches.
export function findCollisionNode(root: THREE.Object3D): THREE.Object3D | null {
  let hit: THREE.Object3D | null = null;
  root.traverse((node) => {
    if (hit) return;
    if (node.name === COLLISION_NODE_NAME) hit = node;
  });
  return hit;
}

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

export interface AuthoredHull {
  vertices: [number, number, number][];
  faces:    number[][];
}

// Extracts authored triangles from a `_collision` child node and returns
// them as polyhedron data ready for CANNON.ConvexPolyhedron — vertices in
// model space, faces as triangle index triples. Returns null when no
// `_collision` node exists, so the caller can fall back to ConvexHull on
// the visual mesh. Assumes the authored mesh is convex (author's
// responsibility); cannon's narrowphase treats it as such regardless.
export function extractAuthoredHull(root: THREE.Object3D): AuthoredHull | null {
  root.updateMatrixWorld(true);
  const collision = findCollisionNode(root);
  if (!collision) return null;

  const vertexMap = new Map<string, number>();
  const vertices: [number, number, number][] = [];
  const faces:    number[][] = [];

  const indexOf = (x: number, y: number, z: number): number => {
    const key = `${x},${y},${z}`;
    const hit = vertexMap.get(key);
    if (hit !== undefined) return hit;
    const idx = vertices.length;
    vertices.push([x, y, z]);
    vertexMap.set(key, idx);
    return idx;
  };

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  collision.traverse((node) => {
    const mesh = node as THREE.Mesh;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geom || !geom.attributes) return;
    const pos = geom.attributes.position as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const index = geom.index;
    const triCount = index ? index.count / 3 : pos.count / 3;
    for (let t = 0; t < triCount; t++) {
      const ia = index ? index.getX(t * 3)     : t * 3;
      const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, ia).applyMatrix4(node.matrixWorld);
      b.fromBufferAttribute(pos, ib).applyMatrix4(node.matrixWorld);
      c.fromBufferAttribute(pos, ic).applyMatrix4(node.matrixWorld);
      faces.push([
        indexOf(a.x, a.y, a.z),
        indexOf(b.x, b.y, b.z),
        indexOf(c.x, c.y, c.z),
      ]);
    }
  });

  if (faces.length === 0) return null;
  return { vertices, faces };
}

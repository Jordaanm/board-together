// Pure convex-hull builder. Wraps three's ConvexHull (quickhull port) to
// produce vertex/face arrays shaped for CANNON.ConvexPolyhedron.
//
// Degenerate input (<4 points, all coplanar) returns HULL_FALLBACK so the
// caller can fall back to AABB. Hulls with more than HULL_FACE_WARN faces
// emit a console.warn but are returned normally — narrowphase will still
// work, the warning just nudges asset authors toward a _collision mesh.

import * as THREE from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';

export interface HullData {
  vertices: [number, number, number][];
  faces:    number[][];
}

export const HULL_FALLBACK = Symbol('hull-fallback');
export type HullFallback = typeof HULL_FALLBACK;

export const HULL_FACE_WARN = 64;
const COPLANAR_EPSILON = 1e-6;

export function buildHull(points: ReadonlyArray<THREE.Vector3>): HullData | HullFallback {
  if (points.length < 4) return HULL_FALLBACK;
  if (isCoplanar(points)) return HULL_FALLBACK;

  const hull = new ConvexHull().setFromPoints(points as THREE.Vector3[]);
  if (hull.faces.length === 0) return HULL_FALLBACK;

  // ConvexHull faces hold Vector3 points (not indices). Dedupe to a vertex
  // table keyed by stringified coordinates, then re-emit each triangular
  // face as a [a, b, c] index triple.
  const vertexMap = new Map<string, number>();
  const vertices: [number, number, number][] = [];
  const faces:    number[][] = [];

  const indexOf = (p: THREE.Vector3): number => {
    const key = `${p.x},${p.y},${p.z}`;
    const hit = vertexMap.get(key);
    if (hit !== undefined) return hit;
    const idx = vertices.length;
    vertices.push([p.x, p.y, p.z]);
    vertexMap.set(key, idx);
    return idx;
  };

  for (const face of hull.faces) {
    // Faces from ConvexHull are triangles whose half-edges walk CCW from
    // outside, which is the winding CANNON.ConvexPolyhedron expects.
    const a = indexOf(face.edge.head().point);
    const b = indexOf(face.edge.next.head().point);
    const c = indexOf(face.edge.next.next.head().point);
    faces.push([a, b, c]);
  }

  if (faces.length > HULL_FACE_WARN) {
    console.warn(`[hullBuilder] hull has ${faces.length} faces (> ${HULL_FACE_WARN}); consider authoring a _collision mesh`);
  }

  return { vertices, faces };
}

// Returns true when all points lie within COPLANAR_EPSILON of a single
// plane. Picks the first non-collinear triple to define the plane; if no
// such triple exists the points are collinear (also degenerate).
function isCoplanar(points: ReadonlyArray<THREE.Vector3>): boolean {
  const p0 = points[0];
  // Find a second point distinct from p0.
  let p1: THREE.Vector3 | null = null;
  for (let i = 1; i < points.length; i++) {
    if (points[i].distanceToSquared(p0) > COPLANAR_EPSILON) { p1 = points[i]; break; }
  }
  if (!p1) return true;

  // Find a third point not collinear with p0-p1.
  const e1 = new THREE.Vector3().subVectors(p1, p0);
  let normal: THREE.Vector3 | null = null;
  for (let i = 0; i < points.length; i++) {
    const e2 = new THREE.Vector3().subVectors(points[i], p0);
    const n  = new THREE.Vector3().crossVectors(e1, e2);
    if (n.lengthSq() > COPLANAR_EPSILON) { normal = n.normalize(); break; }
  }
  if (!normal) return true;

  for (let i = 0; i < points.length; i++) {
    const d = new THREE.Vector3().subVectors(points[i], p0).dot(normal);
    if (Math.abs(d) > COPLANAR_EPSILON) return false;
  }
  return true;
}

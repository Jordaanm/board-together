// Pure convex-hull builder. Wraps three's ConvexHull (quickhull port) to
// produce vertex/face arrays shaped for CANNON.ConvexPolyhedron.
//
// Degenerate input (<4 points, all coplanar) returns HULL_FALLBACK so the
// caller can fall back to AABB. Hulls exceeding MAX_HULL_FACES are
// decimated by furthest-point-sampling the surface vertices down to a
// budget and re-hulling — the narrowphase cost of convex-vs-convex scales
// with face count, so the cap bounds physics-step cost for heavy GLBs.

import * as THREE from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';

export interface HullData {
  vertices: [number, number, number][];
  faces:    number[][];
}

export const HULL_FALLBACK = Symbol('hull-fallback');
export type HullFallback = typeof HULL_FALLBACK;

export const MAX_HULL_FACES = 24;
const COPLANAR_EPSILON = 1e-6;

export function buildHull(points: ReadonlyArray<THREE.Vector3>): HullData | HullFallback {
  if (points.length < 4) return HULL_FALLBACK;
  if (isCoplanar(points)) return HULL_FALLBACK;

  const hull = runConvexHull(points);
  if (hull === null) return HULL_FALLBACK;
  if (hull.faces.length <= MAX_HULL_FACES) return hull;

  return decimate(hull);
}

// Single ConvexHull pass + dedup into the polyhedron-ready face/vertex
// layout. Returns null when the underlying ConvexHull failed (empty
// faces); callers translate that into HULL_FALLBACK or keep the prior
// hull.
function runConvexHull(points: ReadonlyArray<THREE.Vector3>): HullData | null {
  const hull = new ConvexHull().setFromPoints(points as THREE.Vector3[]);
  if (hull.faces.length === 0) return null;

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
  return { vertices, faces };
}

// Picks a subset of hull vertices via furthest-point sampling and re-hulls
// on that subset. Vertex budget derives from Euler's F = 2V - 4 relation
// for triangulated convex polyhedra, so the re-hulled face count lands
// near MAX_HULL_FACES (often slightly under). Falls back to the input
// hull if the reduced point set degenerates.
function decimate(hull: HullData): HullData {
  const vertexBudget = Math.max(4, Math.floor((MAX_HULL_FACES + 4) / 2));
  if (hull.vertices.length <= vertexBudget) return hull;

  const verts = hull.vertices.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const sampled = furthestPointSample(verts, vertexBudget);
  const reduced = runConvexHull(sampled);
  return reduced ?? hull;
}

// Greedy farthest-point sampling: seed with the vertex furthest from the
// centroid, then repeatedly add the vertex whose minimum distance to the
// chosen set is maximised. Deterministic, O(k·n).
function furthestPointSample(points: ReadonlyArray<THREE.Vector3>, k: number): THREE.Vector3[] {
  if (points.length <= k) return points.slice();

  const centroid = new THREE.Vector3();
  for (const p of points) centroid.add(p);
  centroid.multiplyScalar(1 / points.length);

  let seed = 0; let seedD = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = points[i].distanceToSquared(centroid);
    if (d > seedD) { seedD = d; seed = i; }
  }

  const chosen: THREE.Vector3[] = [points[seed]];
  const minD = new Float64Array(points.length);
  for (let i = 0; i < points.length; i++) {
    minD[i] = i === seed ? -Infinity : points[i].distanceToSquared(points[seed]);
  }

  while (chosen.length < k) {
    let pick = -1; let best = -Infinity;
    for (let i = 0; i < points.length; i++) {
      if (minD[i] > best) { best = minD[i]; pick = i; }
    }
    if (pick < 0 || best === -Infinity) break;
    chosen.push(points[pick]);
    const p = points[pick];
    minD[pick] = -Infinity;
    for (let i = 0; i < points.length; i++) {
      if (minD[i] === -Infinity) continue;
      const d = points[i].distanceToSquared(p);
      if (d < minD[i]) minD[i] = d;
    }
  }
  return chosen;
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

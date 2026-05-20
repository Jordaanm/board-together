// Pure builder: CANNON.Shape → THREE.LineSegments wireframe.
//
// Used by HitboxAttachment to visualise the actual collision shape of a
// selected entity. Switches on `Shape.type` rather than instanceof because
// cannon's Cylinder inherits from ConvexPolyhedron and we want a clean
// cylinder render rather than a tessellated hull.
//
// All built line segments share a single `LineBasicMaterial` (depthTest
// off) so the wireframe is visible through occluders — host debug
// inspection should never lose a face behind the table.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';

export const HITBOX_COLOR = 0x00ffff;

export const HITBOX_MATERIAL = new THREE.LineBasicMaterial({
  color:       HITBOX_COLOR,
  depthTest:   false,
  transparent: false,
});

// Lift wireframes above all in-scene geometry. Number is arbitrary so long
// as it exceeds any renderOrder the room sets on its meshes (currently 0
// everywhere — picked 999 to leave room for future overlays underneath).
export const HITBOX_RENDER_ORDER = 999;

export function buildHitboxWireframe(shape: CANNON.Shape): THREE.LineSegments {
  let geometry: THREE.BufferGeometry;
  switch (shape.type) {
    case CANNON.Shape.types.BOX:
      geometry = boxEdges(shape as CANNON.Box);
      break;
    case CANNON.Shape.types.SPHERE:
      geometry = sphereEdges(shape as CANNON.Sphere);
      break;
    case CANNON.Shape.types.CYLINDER:
      geometry = cylinderEdges(shape as CANNON.Cylinder);
      break;
    case CANNON.Shape.types.CONVEXPOLYHEDRON:
      geometry = convexEdges(shape as CANNON.ConvexPolyhedron);
      break;
    default:
      // Unknown shape — return an empty geometry so the caller still gets
      // a valid LineSegments to manage in its scene-graph lifecycle.
      geometry = new THREE.BufferGeometry();
  }
  const lines = new THREE.LineSegments(geometry, HITBOX_MATERIAL);
  lines.renderOrder = HITBOX_RENDER_ORDER;
  return lines;
}

function boxEdges(shape: CANNON.Box): THREE.BufferGeometry {
  const { x, y, z } = shape.halfExtents;
  // BoxGeometry full extents = 2× halfExtents.
  return new THREE.EdgesGeometry(new THREE.BoxGeometry(2 * x, 2 * y, 2 * z));
}

function sphereEdges(shape: CANNON.Sphere): THREE.BufferGeometry {
  // 12×8 keeps the silhouette readable without flooding the line buffer.
  return new THREE.EdgesGeometry(new THREE.SphereGeometry(shape.radius, 12, 8));
}

function cylinderEdges(shape: CANNON.Cylinder): THREE.BufferGeometry {
  // cannon's Cylinder is authored along +Y; three's CylinderGeometry default
  // matches, so no extra rotation needed.
  const geom = new THREE.CylinderGeometry(
    shape.radiusTop,
    shape.radiusBottom,
    shape.height,
    Math.max(shape.numSegments, 8),
  );
  return new THREE.EdgesGeometry(geom);
}

function convexEdges(shape: CANNON.ConvexPolyhedron): THREE.BufferGeometry {
  // Reconstruct a BufferGeometry from the polyhedron's vertices + faces,
  // then let EdgesGeometry dedupe shared edges. Faces may be triangles or
  // higher-order polygons — fan-triangulate around face[0] so EdgesGeometry
  // (which only consumes triangles) sees the full topology.
  const positions: number[] = [];
  for (const face of shape.faces) {
    for (let i = 1; i < face.length - 1; i++) {
      const a = shape.vertices[face[0]];
      const b = shape.vertices[face[i]];
      const c = shape.vertices[face[i + 1]];
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  return new THREE.EdgesGeometry(geom);
}

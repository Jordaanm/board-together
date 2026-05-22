import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import { resolveDragTarget } from './DragTargetResolver';

// Build a downward ray from (x, 5, z) pointing -Y, then set the raycaster.
function downwardRaycaster(x: number, z: number): THREE.Raycaster {
  const r = new THREE.Raycaster();
  r.set(new THREE.Vector3(x, 5, z), new THREE.Vector3(0, -1, 0));
  return r;
}

// Caller-side mesh registry: tracks each mesh's entity id + half-extents so
// the resolver test can assert exclusion / inclusion without coupling to the
// World facade.
function makeMesh(opts: {
  size:     [number, number, number];
  position: [number, number, number];
}): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(opts.size[0], opts.size[1], opts.size[2]),
  );
  m.position.set(opts.position[0], opts.position[1], opts.position[2]);
  // Raycaster reads matrixWorld for hit math; standalone meshes start with an
  // identity matrix until something (parent traversal or explicit call)
  // updates it.
  m.updateMatrixWorld(true);
  return m;
}

describe('resolveDragTarget — bare-surface hit', () => {
  test('cursor over a table-like mesh: targetY = surfaceY + hoverOffset + halfExtentY', () => {
    const table = makeMesh({ size: [4, 0.2, 4], position: [0, 0, 0] });
    const result = resolveDragTarget({
      raycaster:          downwardRaycaster(0.5, 0.5),
      candidateMeshes:    [table],
      draggedHalfExtentY: 0.05,
      hoverOffset:        0.1,
      fallbackY:          0.5,
    });
    expect(result.kind).toBe('bare');
    if (result.kind !== 'bare') return;
    // Top face of a box at y=0 with height 0.2 → y=0.1. Plus hoverOffset 0.1
    // + halfExtentY 0.05 = 0.25.
    expect(result.position.x).toBeCloseTo(0.5);
    expect(result.position.z).toBeCloseTo(0.5);
    expect(result.position.y).toBeCloseTo(0.25);
    expect(result.surfaceY).toBeCloseTo(0.1);
  });

  test('cursor over a taller mesh: surfaceY follows the taller mesh', () => {
    const table = makeMesh({ size: [4, 0.2, 4], position: [0, 0, 0] });
    const die   = makeMesh({ size: [0.4, 0.4, 0.4], position: [0, 0.4, 0] });
    const result = resolveDragTarget({
      raycaster:          downwardRaycaster(0, 0),  // ray passes through die
      candidateMeshes:    [table, die],
      draggedHalfExtentY: 0.05,
      hoverOffset:        0.1,
      fallbackY:          0.5,
    });
    expect(result.kind).toBe('bare');
    if (result.kind !== 'bare') return;
    // Die top: position.y=0.4 + halfHeight=0.2 = 0.6. Closest hit wins.
    expect(result.surfaceY).toBeCloseTo(0.6);
    expect(result.position.y).toBeCloseTo(0.75);  // 0.6 + 0.1 + 0.05
  });
});

describe('resolveDragTarget — exclusion (caller filters candidateMeshes)', () => {
  test('dragged entity passed via candidateMeshes would be hit; caller excludes it', () => {
    // The resolver itself doesn't filter — exclusion is the caller's job.
    // This test documents that contract: if the dragged mesh is included,
    // it WILL be hit. GrabTool / the integration must drop it before calling.
    const dragged = makeMesh({ size: [0.5, 0.1, 0.7], position: [0, 1, 0] });
    const table   = makeMesh({ size: [4, 0.2, 4],     position: [0, 0, 0] });
    const withDragged = resolveDragTarget({
      raycaster:          downwardRaycaster(0, 0),
      candidateMeshes:    [dragged, table],
      draggedHalfExtentY: 0.05,
      hoverOffset:        0.1,
      fallbackY:          0.5,
    });
    expect(withDragged.kind).toBe('bare');
    if (withDragged.kind !== 'bare') return;
    expect(withDragged.surfaceY).toBeCloseTo(1.05);  // dragged top

    // Once filtered out (the caller's responsibility), the table is hit.
    const filtered = resolveDragTarget({
      raycaster:          downwardRaycaster(0, 0),
      candidateMeshes:    [table],
      draggedHalfExtentY: 0.05,
      hoverOffset:        0.1,
      fallbackY:          0.5,
    });
    expect(filtered.kind).toBe('bare');
    if (filtered.kind !== 'bare') return;
    expect(filtered.surfaceY).toBeCloseTo(0.1);
  });

  test('held entity (any seat) excluded by caller: cursor passes through to the surface beneath', () => {
    const heldByOther = makeMesh({ size: [0.5, 0.1, 0.7], position: [0, 0.8, 0] });
    const table       = makeMesh({ size: [4, 0.2, 4],     position: [0, 0, 0] });
    // Caller skips heldByOther because some seat holds it.
    const result = resolveDragTarget({
      raycaster:          downwardRaycaster(0, 0),
      candidateMeshes:    [table],
      draggedHalfExtentY: 0.05,
      hoverOffset:        0.1,
      fallbackY:          0.5,
    });
    expect(result.kind).toBe('bare');
    if (result.kind !== 'bare') return;
    expect(result.surfaceY).toBeCloseTo(0.1);
    // Sanity: the held mesh exists in the scene but was filtered out.
    expect(heldByOther.position.y).toBe(0.8);
  });
});

describe('resolveDragTarget — off-table fallback', () => {
  test('ray misses every candidate: returns none + projects cursor onto fallback plane', () => {
    const table = makeMesh({ size: [1, 0.2, 1], position: [10, 0, 10] });
    const result = resolveDragTarget({
      raycaster:          downwardRaycaster(0, 0),  // way off the table
      candidateMeshes:    [table],
      draggedHalfExtentY: 0.05,
      hoverOffset:        0.1,
      fallbackY:          0.75,
    });
    expect(result.kind).toBe('none');
    if (result.kind !== 'none') return;
    expect(result.fallbackY).toBe(0.75);
    expect(result.position.x).toBeCloseTo(0);
    expect(result.position.z).toBeCloseTo(0);
    expect(result.position.y).toBeCloseTo(0.75);
  });

  test('empty candidateMeshes: returns none + fallback', () => {
    const result = resolveDragTarget({
      raycaster:          downwardRaycaster(2, 3),
      candidateMeshes:    [],
      draggedHalfExtentY: 0.05,
      hoverOffset:        0.1,
      fallbackY:          1.2,
    });
    expect(result.kind).toBe('none');
    if (result.kind !== 'none') return;
    expect(result.position.x).toBeCloseTo(2);
    expect(result.position.z).toBeCloseTo(3);
    expect(result.position.y).toBeCloseTo(1.2);
  });

  test('cursor moving off-table at last valid Y stays at that Y', () => {
    // First, get a valid hit so we know what `fallbackY` should be.
    const table = makeMesh({ size: [2, 0.2, 2], position: [0, 0, 0] });
    const onTable = resolveDragTarget({
      raycaster:          downwardRaycaster(0, 0),
      candidateMeshes:    [table],
      draggedHalfExtentY: 0.05,
      hoverOffset:        0.1,
      fallbackY:          1.0,
    });
    expect(onTable.kind).toBe('bare');
    const lastValidY = onTable.kind === 'bare' ? onTable.position.y : 0;

    // Now cursor moves off the table; caller passes lastValidY as fallbackY.
    const offTable = resolveDragTarget({
      raycaster:          downwardRaycaster(5, 5),  // off the table
      candidateMeshes:    [table],
      draggedHalfExtentY: 0.05,
      hoverOffset:        0.1,
      fallbackY:          lastValidY,
    });
    expect(offTable.kind).toBe('none');
    if (offTable.kind !== 'none') return;
    expect(offTable.position.y).toBeCloseTo(lastValidY);
    // X/Z still follows cursor.
    expect(offTable.position.x).toBeCloseTo(5);
    expect(offTable.position.z).toBeCloseTo(5);
  });
});

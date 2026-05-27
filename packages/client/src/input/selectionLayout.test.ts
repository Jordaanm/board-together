import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import {
  resolveSelectionLayout,
  GRID_PADDING,
  type EntityPose,
  type EntityCapability,
  type CameraAxes,
  type ResolveSelectionLayoutInput,
} from './selectionLayout';

const Q_IDENT: [number, number, number, number] = [0, 0, 0, 1];

// Default camera: looking down -Z from +Z (right = +X).
const DEFAULT_CAMERA: CameraAxes = {
  forward: [0, 0, -1],
  right:   [1, 0, 0],
};

// Yawed 90° CCW about +Y: camera looks in -X direction; right is -Z.
const YAW_90_CAMERA: CameraAxes = {
  forward: [-1, 0, 0],
  right:   [0, 0, -1],
};

// Top-down camera: forward = -Y, right = +X, up = -Z.
const TOP_DOWN_CAMERA: CameraAxes = {
  forward: [0, -1, 0],
  right:   [1, 0, 0],
};

interface World {
  pose:    Map<string, EntityPose>;
  extent:  Map<string, [number, number, number]>;
  cap:     Map<string, EntityCapability>;
}

function makeWorld(): World {
  return { pose: new Map(), extent: new Map(), cap: new Map() };
}

function place(
  w: World,
  id: string,
  position: [number, number, number],
  extent: [number, number, number] = [0.25, 0.25, 0.25],
  rotation: [number, number, number, number] = Q_IDENT,
  cap: EntityCapability = { claimable: true, movable: true, extentKnown: true },
) {
  w.pose.set(id, { position, rotation });
  w.extent.set(id, extent);
  w.cap.set(id, cap);
}

function inputs(
  w: World,
  selection: readonly string[],
  columns: number,
  camera: CameraAxes = DEFAULT_CAMERA,
): ResolveSelectionLayoutInput {
  return {
    selection,
    getTransform:  (id) => w.pose.get(id) ?? null,
    getExtent:     (id) => w.extent.get(id) ?? null,
    getCapability: (id) => w.cap.get(id) ?? { claimable: false, movable: false, extentKnown: false },
    camera,
    columns,
  };
}

describe('resolveSelectionLayout — basic cases', () => {
  test('empty selection returns an empty plan', () => {
    const w = makeWorld();
    expect(resolveSelectionLayout(inputs(w, [], 3))).toEqual([]);
  });

  test('single-entity selection returns an empty plan', () => {
    const w = makeWorld();
    place(w, 'a', [0, 0, 0]);
    expect(resolveSelectionLayout(inputs(w, ['a'], 3))).toEqual([]);
  });

  test('columns < 1 returns empty plan', () => {
    const w = makeWorld();
    place(w, 'a', [0, 0, 0]);
    place(w, 'b', [1, 0, 0]);
    expect(resolveSelectionLayout(inputs(w, ['a', 'b'], 0))).toEqual([]);
  });
});

describe('resolveSelectionLayout — 3×3 grid', () => {
  test('9 entities with columns=3 produces 3×3 grid centered on input centroid', () => {
    const w = makeWorld();
    // Scatter 9 entities; centroid will be (1, 0, 1) chosen to be non-origin.
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) {
      const id = `e${i}`;
      ids.push(id);
      place(w, id, [Math.random() * 4 - 1, 0, Math.random() * 4 - 1], [0.25, 0.25, 0.25]);
    }
    // Compute the actual centroid.
    let cx = 0, cz = 0;
    for (const id of ids) {
      const p = w.pose.get(id)!.position;
      cx += p[0]; cz += p[2];
    }
    cx /= 9; cz /= 9;

    const plan = resolveSelectionLayout(inputs(w, ids, 3));
    expect(plan).toHaveLength(9);

    // Cell side = 2 * 0.25 + 0.05 = 0.55.
    const cellSide = 0.5 + GRID_PADDING;

    // Output centroid should equal input centroid.
    let ox = 0, oz = 0;
    for (const p of plan) { ox += p.position[0]; oz += p.position[2]; }
    ox /= 9; oz /= 9;
    expect(ox).toBeCloseTo(cx);
    expect(oz).toBeCloseTo(cz);

    // 3 distinct X values and 3 distinct Z values, spaced by cellSide.
    const xs = Array.from(new Set(plan.map(p => Math.round(p.position[0] * 1000) / 1000))).sort((a, b) => a - b);
    const zs = Array.from(new Set(plan.map(p => Math.round(p.position[2] * 1000) / 1000))).sort((a, b) => a - b);
    expect(xs).toHaveLength(3);
    expect(zs).toHaveLength(3);
    expect(xs[1] - xs[0]).toBeCloseTo(cellSide);
    expect(xs[2] - xs[1]).toBeCloseTo(cellSide);
    expect(zs[1] - zs[0]).toBeCloseTo(cellSide);
    expect(zs[2] - zs[1]).toBeCloseTo(cellSide);
  });
});

describe('resolveSelectionLayout — partial last row', () => {
  test('5 entities columns=3 → 3 in row 0, 2 in row 1; partial row sits closer to camera', () => {
    const w = makeWorld();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `e${i}`;
      ids.push(id);
      place(w, id, [i - 2, 0, 0], [0.25, 0.25, 0.25]);
    }
    const plan = resolveSelectionLayout(inputs(w, ids, 3));
    expect(plan).toHaveLength(5);

    // Default camera: forward = -Z, so "farther from camera" = -Z direction
    // (more-negative z). Row 0 should sit at more-negative z; partial row 1
    // at less-negative z (nearer the camera at +Z).
    // Plan items are emitted in cell order: indices 0..2 = row 0, 3..4 = row 1.
    const row0Z = plan.slice(0, 3).map(p => p.position[2]);
    const row1Z = plan.slice(3, 5).map(p => p.position[2]);
    // All entries in row 0 share a z.
    expect(row0Z[0]).toBeCloseTo(row0Z[1]);
    expect(row0Z[1]).toBeCloseTo(row0Z[2]);
    expect(row1Z[0]).toBeCloseTo(row1Z[1]);
    // Row 0 is farther from camera (more negative z); row 1 is nearer (greater z).
    expect(row0Z[0]).toBeLessThan(row1Z[0]);
  });
});

describe('resolveSelectionLayout — over-wide grid', () => {
  test('2 entities columns=5 → 1 row, 2 filled cells, grid width sized as 5 columns', () => {
    const w = makeWorld();
    place(w, 'a', [-1, 0, 0], [0.25, 0.25, 0.25]);
    place(w, 'b', [ 1, 0, 0], [0.25, 0.25, 0.25]);
    const plan = resolveSelectionLayout(inputs(w, ['a', 'b'], 5));
    expect(plan).toHaveLength(2);

    const cellSide = 0.5 + GRID_PADDING;
    // Cells [0,0] and [0,1] with cols=5. Offsets: (0 - 2) * cellSide and (1 - 2) * cellSide.
    // i.e. -2 * cellSide and -1 * cellSide along right axis (+X with default camera).
    // Centroid x = 0.
    const xs = plan.map(p => p.position[0]).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-2 * cellSide);
    expect(xs[1]).toBeCloseTo(-1 * cellSide);
    // Single row → both at the same z (centered).
    expect(plan[0].position[2]).toBeCloseTo(plan[1].position[2]);
  });
});

describe('resolveSelectionLayout — mixed-size cell sizing', () => {
  test('cell side fits the largest object plus padding', () => {
    const w = makeWorld();
    place(w, 'small', [-1, 0, 0], [0.1,  0.1,  0.1]);
    place(w, 'big',   [ 1, 0, 0], [0.6,  0.05, 0.6]);   // biggest half-extent = 0.6
    const plan = resolveSelectionLayout(inputs(w, ['small', 'big'], 2));
    expect(plan).toHaveLength(2);

    const cellSide = 2 * 0.6 + GRID_PADDING;
    // Two cells side-by-side: spacing = cellSide.
    const xs = plan.map(p => p.position[0]).sort((a, b) => a - b);
    expect(xs[1] - xs[0]).toBeCloseTo(cellSide);
  });
});

describe('resolveSelectionLayout — per-entity Y', () => {
  test('each plan Y derives from that entity own half-extent', () => {
    const w = makeWorld();
    place(w, 'card', [0, 0, 0], [0.4, 0.01, 0.6]);  // thin card
    place(w, 'die',  [1, 0, 0], [0.3, 0.3,  0.3]);  // cube die
    const plan = resolveSelectionLayout(inputs(w, ['card', 'die'], 2));
    const byId = new Map(plan.map(p => [p.entityId, p]));
    expect(byId.get('card')!.position[1]).toBeCloseTo(0.01);
    expect(byId.get('die')!.position[1]).toBeCloseTo(0.3);
  });
});

describe('resolveSelectionLayout — rotation', () => {
  test('face-down state preserved through layout; all entries share yaw', () => {
    const w = makeWorld();
    // X-tilt of π flips the card face-down: local +Y maps to world -Y.
    const tiltX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
    const tiltQ: [number, number, number, number] = [tiltX.x, tiltX.y, tiltX.z, tiltX.w];
    place(w, 'a', [-1, 0, 0], [0.25, 0.25, 0.25], tiltQ);
    place(w, 'b', [ 1, 0, 0], [0.25, 0.25, 0.25], tiltQ);

    const plan = resolveSelectionLayout(inputs(w, ['a', 'b'], 2, DEFAULT_CAMERA));
    // Local +Y after rotation should still point world -Y for both.
    for (const p of plan) {
      const v = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(...p.rotation));
      expect(v.x).toBeCloseTo(0);
      expect(v.y).toBeCloseTo(-1);
      expect(v.z).toBeCloseTo(0);
    }

    // All entries share the same overall rotation (since tilt is identical).
    for (let i = 0; i < 4; i++) {
      expect(plan[0].rotation[i]).toBeCloseTo(plan[1].rotation[i]);
    }
  });

  test('upright cards: Y rotation aligned to grid forward axis', () => {
    const w = makeWorld();
    place(w, 'a', [-1, 0, 0]);
    place(w, 'b', [ 1, 0, 0]);
    const plan = resolveSelectionLayout(inputs(w, ['a', 'b'], 2, DEFAULT_CAMERA));
    // Default camera: gridForward = (0, -1) → expected yaw = atan2(0, -1) = π.
    // Apply rotation to local +Z; it should land at gridForward.
    for (const p of plan) {
      const v = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...p.rotation));
      expect(v.x).toBeCloseTo(0);
      expect(v.z).toBeCloseTo(-1);
    }
  });

  test('Z-tilt is preserved through the layout', () => {
    const w = makeWorld();
    // Rotate by π/4 about Z (a die "on edge" along Z).
    const tiltZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4);
    const tiltQ: [number, number, number, number] = [tiltZ.x, tiltZ.y, tiltZ.z, tiltZ.w];
    place(w, 'a', [-1, 0, 0], [0.25, 0.25, 0.25], tiltQ);
    place(w, 'b', [ 1, 0, 0], [0.25, 0.25, 0.25], tiltQ);
    const plan = resolveSelectionLayout(inputs(w, ['a', 'b'], 2, DEFAULT_CAMERA));
    // Output rotation should have non-zero Z-tilt of the same magnitude.
    const e = new THREE.Euler().setFromQuaternion(
      new THREE.Quaternion(...plan[0].rotation), 'YXZ',
    );
    expect(Math.abs(e.z)).toBeCloseTo(Math.PI / 4);
  });

  test('yawed camera produces correspondingly-yawed rotation', () => {
    const w = makeWorld();
    place(w, 'a', [-1, 0, 0]);
    place(w, 'b', [ 1, 0, 0]);
    const plan = resolveSelectionLayout(inputs(w, ['a', 'b'], 2, YAW_90_CAMERA));
    const euler = new THREE.Euler().setFromQuaternion(
      new THREE.Quaternion(...plan[0].rotation), 'YXZ',
    );
    // YAW_90 right = (0,0,-1), gridForward = (z, -x) of (0, -1) = (-1, 0).
    // Yaw = atan2(-1, 0) = -π/2.
    expect(euler.y).toBeCloseTo(-Math.PI / 2);
  });
});

describe('resolveSelectionLayout — camera-yaw cell assignment', () => {
  test('rotated camera → still reads top-left-first in screen space', () => {
    const w = makeWorld();
    // Three entities arranged along world X. With default camera, leftmost
    // (most-negative x) → cell 0. With yawed camera, the entity nearer to
    // screen-top-left becomes cell 0 instead.
    place(w, 'L', [-2, 0, 0]);
    place(w, 'M', [ 0, 0, 0]);
    place(w, 'R', [ 2, 0, 0]);

    const defaultPlan = resolveSelectionLayout(inputs(w, ['L', 'M', 'R'], 3, DEFAULT_CAMERA));
    expect(defaultPlan.map(p => p.entityId)).toEqual(['L', 'M', 'R']);

    // Yawed 90° CCW camera looks in -X; right = -Z. The entities sit along
    // world X — perpendicular to the new viewing direction — so they vary
    // only in screen-X for the new camera. Sort by P·right ascending:
    // P·right = x*0 + z*-1 = 0 for all (all at z=0), so falls back to insertion
    // order? Need a tiebreak. Better test: put entities along two axes.
    const w2 = makeWorld();
    place(w2, 'TL', [-2, 0, -2]);   // top-left in default cam = far-left
    place(w2, 'TR', [ 2, 0, -2]);   // top-right
    place(w2, 'BL', [-2, 0,  2]);   // bottom-left
    place(w2, 'BR', [ 2, 0,  2]);   // bottom-right

    const defaultOrder = resolveSelectionLayout(inputs(w2, ['BR', 'TL', 'BL', 'TR'], 2, DEFAULT_CAMERA));
    // Default cam: forward XZ direction = (0, -1). Sort by P·forward desc:
    //   P·forward for TL/TR (z=-2): -2 * -1 = +2  → farther first
    //   P·forward for BL/BR (z=+2): +2 * -1 = -2  → closer second
    // Within row, sort by P·right asc: right = +X, so L (-x) before R (+x).
    expect(defaultOrder.map(p => p.entityId)).toEqual(['TL', 'TR', 'BL', 'BR']);

    // Yawed 90° CCW: forward XZ = (-1, 0). Sort by P·forward desc:
    //   P·forward for TL/BL (x=-2): -2*-1 = +2 → farther
    //   P·forward for TR/BR (x=+2): +2*-1 = -2 → closer
    // Within row, sort by P·right asc: right = (0,0,-1), so P·right = -z.
    //   For TL/BL: TL z=-2 → 2;  BL z=+2 → -2.  Ascending: BL, TL.
    // Final: BL, TL, BR, TR.
    const yawedOrder = resolveSelectionLayout(inputs(w2, ['BR', 'TL', 'BL', 'TR'], 2, YAW_90_CAMERA));
    expect(yawedOrder.map(p => p.entityId)).toEqual(['BL', 'TL', 'BR', 'TR']);
  });
});

describe('resolveSelectionLayout — top-down camera', () => {
  test('top-down camera produces a well-defined plan', () => {
    const w = makeWorld();
    for (let i = 0; i < 4; i++) {
      place(w, `e${i}`, [i - 1.5, 0, 0]);
    }
    const plan = resolveSelectionLayout(inputs(w, ['e0', 'e1', 'e2', 'e3'], 2, TOP_DOWN_CAMERA));
    expect(plan).toHaveLength(4);
    // No NaNs.
    for (const p of plan) {
      expect(Number.isFinite(p.position[0])).toBe(true);
      expect(Number.isFinite(p.position[1])).toBe(true);
      expect(Number.isFinite(p.position[2])).toBe(true);
      for (const c of p.rotation) expect(Number.isFinite(c)).toBe(true);
    }
  });
});

describe('resolveSelectionLayout — eligibility filter', () => {
  test('unclaimable / immovable / no-extent entities are excluded from the plan and the math', () => {
    const w = makeWorld();
    place(w, 'a',     [-1, 0, 0], [0.25, 0.25, 0.25]);
    place(w, 'b',     [ 1, 0, 0], [0.25, 0.25, 0.25]);
    // 'held' should be skipped (unclaimable). Its (5, 0, 0) position would
    // otherwise pull the centroid.
    place(w, 'held',  [ 5, 0, 0], [0.25, 0.25, 0.25],
      Q_IDENT, { claimable: false, movable: true,  extentKnown: true });
    place(w, 'lock',  [-5, 0, 0], [0.25, 0.25, 0.25],
      Q_IDENT, { claimable: true,  movable: false, extentKnown: true });
    place(w, 'noext', [ 0, 0, 5], [0.25, 0.25, 0.25],
      Q_IDENT, { claimable: true,  movable: true,  extentKnown: false });

    const plan = resolveSelectionLayout(inputs(w, ['a', 'b', 'held', 'lock', 'noext'], 2));
    expect(plan).toHaveLength(2);
    const ids = new Set(plan.map(p => p.entityId));
    expect(ids).toEqual(new Set(['a', 'b']));

    // Centroid is mean of a and b only → x=0.
    const meanX = (plan[0].position[0] + plan[1].position[0]) / 2;
    expect(meanX).toBeCloseTo(0);
  });

  test('fewer than two eligible entities → empty plan', () => {
    const w = makeWorld();
    place(w, 'a',    [0, 0, 0]);
    place(w, 'held', [1, 0, 0], [0.25, 0.25, 0.25], Q_IDENT,
      { claimable: false, movable: true, extentKnown: true });
    expect(resolveSelectionLayout(inputs(w, ['a', 'held'], 3))).toEqual([]);
  });
});

describe('resolveSelectionLayout — determinism and purity', () => {
  test('same inputs produce the same plan', () => {
    const w = makeWorld();
    for (let i = 0; i < 6; i++) place(w, `e${i}`, [i - 2.5, 0, (i % 2) - 0.5]);
    const ids = ['e0', 'e1', 'e2', 'e3', 'e4', 'e5'];
    const a = resolveSelectionLayout(inputs(w, ids, 3));
    const b = resolveSelectionLayout(inputs(w, ids, 3));
    expect(a).toEqual(b);
  });

  test('does not mutate inputs', () => {
    const w = makeWorld();
    place(w, 'a', [-1, 0, 0]);
    place(w, 'b', [ 1, 0, 0]);
    const selection = Object.freeze(['a', 'b']) as readonly string[];
    const cam = Object.freeze({
      forward: Object.freeze([0, 0, -1]) as unknown as [number, number, number],
      right:   Object.freeze([1, 0, 0])  as unknown as [number, number, number],
    }) as CameraAxes;
    const before = JSON.stringify({
      a: w.pose.get('a'), b: w.pose.get('b'),
      ea: w.extent.get('a'), eb: w.extent.get('b'),
    });
    const plan = resolveSelectionLayout({
      selection,
      getTransform:  (id) => w.pose.get(id) ?? null,
      getExtent:     (id) => w.extent.get(id) ?? null,
      getCapability: (id) => w.cap.get(id)!,
      camera:        cam,
      columns:       2,
    });
    expect(plan).toHaveLength(2);
    const after = JSON.stringify({
      a: w.pose.get('a'), b: w.pose.get('b'),
      ea: w.extent.get('a'), eb: w.extent.get('b'),
    });
    expect(after).toBe(before);
  });
});

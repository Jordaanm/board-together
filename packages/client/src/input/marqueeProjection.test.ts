import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import {
  entitiesInMarquee,
  ndcRectFromScreen,
  type CandidateInput,
} from './marqueeProjection';

// Predictable camera: looking down the -Z axis from +Y, perspective with
// 90° FOV and aspect 1. Anything in the box (-1..1, 0..2, -1..1) lands
// roughly inside the NDC rect (-1..1, -1..1) under this projection.
function makeCamera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
  cam.position.set(0, 5, 5);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

function candidate(id: string, x: number, y: number, z: number): CandidateInput {
  return { id, worldPosition: new THREE.Vector3(x, y, z) };
}

describe('ndcRectFromScreen', () => {
  const rect = { left: 0, top: 0, width: 100, height: 100 };

  test('top-left → bottom-right drag produces normalised NDC rect', () => {
    const r = ndcRectFromScreen({ x: 25, y: 25 }, { x: 75, y: 75 }, rect);
    expect(r.x0).toBeCloseTo(-0.5);
    expect(r.x1).toBeCloseTo( 0.5);
    expect(r.y0).toBeCloseTo(-0.5);
    expect(r.y1).toBeCloseTo( 0.5);
  });

  test('inverted drag (bottom-right → top-left) normalises identically', () => {
    const r1 = ndcRectFromScreen({ x: 25, y: 25 }, { x: 75, y: 75 }, rect);
    const r2 = ndcRectFromScreen({ x: 75, y: 75 }, { x: 25, y: 25 }, rect);
    expect(r2).toEqual(r1);
  });
});

describe('entitiesInMarquee', () => {
  test('entity at the camera focal point lands in a centered rect', () => {
    const cam = makeCamera();
    const rect = { x0: -0.5, x1: 0.5, y0: -0.5, y1: 0.5 };
    const out = entitiesInMarquee([candidate('a', 0, 0, 0)], rect, cam);
    expect([...out]).toEqual(['a']);
  });

  test('entity far off to the side is excluded', () => {
    const cam = makeCamera();
    const rect = { x0: -0.2, x1: 0.2, y0: -0.2, y1: 0.2 };
    const out = entitiesInMarquee([
      candidate('center', 0, 0, 0),
      candidate('right',  50, 0, 0),
    ], rect, cam);
    expect([...out]).toEqual(['center']);
  });

  test('entity behind the camera is excluded even if projected x/y land inside the rect', () => {
    const cam = makeCamera();
    // Camera at (0,5,5) looking at origin → forward is roughly (0,-1,-1).
    // Behind the camera means + along that forward = (0, +y, +z) far from origin.
    const rect = { x0: -1, x1: 1, y0: -1, y1: 1 };
    const out = entitiesInMarquee([
      candidate('front',  0, 0, 0),
      candidate('behind', 0, 200, 200),
    ], rect, cam);
    expect(out.has('front')).toBe(true);
    expect(out.has('behind')).toBe(false);
  });

  test('multiple entities partition correctly inside vs outside', () => {
    const cam = makeCamera();
    const rect = { x0: -0.3, x1: 0.3, y0: -0.3, y1: 0.3 };
    const out = entitiesInMarquee([
      candidate('a', 0, 0, 0),
      candidate('b', 0, 0, 0.5),
      candidate('c', 3, 0, 0),
      candidate('d', 0, 0, -3),
    ], rect, cam);
    expect(out.has('a')).toBe(true);
    expect(out.has('c')).toBe(false);
  });

  test('empty candidate iterable returns empty set', () => {
    const out = entitiesInMarquee([], { x0: -1, x1: 1, y0: -1, y1: 1 }, makeCamera());
    expect(out.size).toBe(0);
  });
});

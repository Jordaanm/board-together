// _collision convention handling — issue #2 of planning/issues--hull.md.

import { describe, test, expect, vi } from 'vitest';
import * as THREE from 'three';
import { processCollisionConvention } from './MeshComponent';

function makeCloneWithCollision(): THREE.Object3D {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2))); // visual
  const collider = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  collider.name = '_collision';
  root.add(collider);
  return root;
}

describe('processCollisionConvention — visible-mesh stripping', () => {
  test('removes the _collision child from the clone', () => {
    const clone = makeCloneWithCollision();
    expect(clone.children).toHaveLength(2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    processCollisionConvention(clone, 'base:bag/default', 'bag', 'b-1', 'auto-hull');
    warn.mockRestore();
    expect(clone.children).toHaveLength(1);
    expect(clone.children[0].name).not.toBe('_collision');
  });

  test('no-op when the clone has no _collision child', () => {
    const clone = new THREE.Group();
    clone.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    processCollisionConvention(clone, 'base:bag/default', 'bag', 'b-1', undefined);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    expect(clone.children).toHaveLength(1);
  });

  test('case-sensitive: similarly-named children pass through unchanged', () => {
    const clone = new THREE.Group();
    clone.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    const decoy = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    decoy.name = '_collision_temp';
    clone.add(decoy);
    processCollisionConvention(clone, 'base:bag/default', 'bag', 'b-1', undefined);
    expect(clone.children).toHaveLength(2);
  });
});

describe('processCollisionConvention — mismatch warning', () => {
  test('warns when _collision is present but physics.shape is not auto-hull', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    processCollisionConvention(makeCloneWithCollision(), 'base:chest/lid', 'chest', 'c-7', undefined);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain('base:chest/lid');
    expect(msg).toContain('chest');
    expect(msg).toContain('c-7');
    warn.mockRestore();
  });

  test('warns when physics.shape is "box" (any value other than auto-hull)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    processCollisionConvention(makeCloneWithCollision(), 'base:bag/default', 'bag', 'b-1', 'box');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('does NOT warn when physics.shape is auto-hull', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    processCollisionConvention(makeCloneWithCollision(), 'base:bag/default', 'bag', 'b-1', 'auto-hull');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

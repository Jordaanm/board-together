// @vitest-environment jsdom
//
// Issue #5 of issues--multiselect.md — GroupDragController orchestrates the
// per-entity HoldService claims + GroupTransform offsets used by a multi-
// entity rigid-body drag. Tests cover the failure modes called out in the
// PRD: anchor failure aborts, non-anchor failure shrinks the drag group.

import { describe, test, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { GroupDragController } from './GroupDragController';
import { type EntityHandle } from '../entity/world';
import { TransformComponent } from '../entity/components/TransformComponent';

interface FakeOpts {
  position?: [number, number, number];
  holdsOk?:  boolean;
}

class FakeHandle {
  obj: THREE.Object3D;
  held = false;
  released = false;
  lastReleaseVelocity: { vx: number; vy: number; vz: number } | undefined;
  positions: Array<[number, number, number]> = [];

  constructor(public id: string, opts: FakeOpts = {}) {
    this.obj = new THREE.Object3D();
    const [x, y, z] = opts.position ?? [0, 0, 0];
    this.obj.position.set(x, y, z);
    this.holdsOk = opts.holdsOk ?? true;
  }
  holdsOk: boolean;

  get entity(): unknown { return { id: this.id }; }

  get(cls: { typeId: string }): unknown {
    if (cls === (TransformComponent as unknown as { typeId: string })
        || cls.typeId === 'transform') {
      return { object3d: this.obj, state: { position: [this.obj.position.x, this.obj.position.y, this.obj.position.z], rotation: [0, 0, 0, 1] } };
    }
    return undefined;
  }
  canStartDrag(): boolean { return true; }
  tryHold(): boolean {
    if (!this.holdsOk) return false;
    this.held = true;
    return true;
  }
  heldBy(): null { return null; }
  release(vel?: { vx: number; vy: number; vz: number }): void {
    this.released = true;
    this.lastReleaseVelocity = vel;
  }
  setPosition(x: number, y: number, z: number): void {
    this.positions.push([x, y, z]);
    this.obj.position.set(x, y, z);
  }
}

function asHandle(h: FakeHandle): EntityHandle {
  return h as unknown as EntityHandle;
}

describe('GroupDragController', () => {
  let ctrl: GroupDragController;

  beforeEach(() => {
    ctrl = new GroupDragController();
  });

  test('begin claims anchor + members, applyAnchorTranslation moves members in formation', () => {
    const anchor  = new FakeHandle('A', { position: [0, 0, 0] });
    const member1 = new FakeHandle('B', { position: [1, 0, 0] });
    const member2 = new FakeHandle('C', { position: [0, 0, 2] });

    expect(ctrl.begin(asHandle(anchor), [asHandle(member1), asHandle(member2)], 0)).toBe(true);
    expect(anchor.held).toBe(true);
    expect(member1.held).toBe(true);
    expect(member2.held).toBe(true);

    ctrl.applyAnchorTranslation(5, 0, 5);
    // Member1 should be at (6, 0, 5); Member2 at (5, 0, 7) — anchor moved
    // (+5, +5) so each member translates by the same delta.
    expect(member1.positions.at(-1)).toEqual([6, 0, 5]);
    expect(member2.positions.at(-1)).toEqual([5, 0, 7]);
  });

  test('anchor hold failure aborts the drag — no members claimed', () => {
    const anchor  = new FakeHandle('A', { holdsOk: false });
    const member1 = new FakeHandle('B');

    expect(ctrl.begin(asHandle(anchor), [asHandle(member1)], 0)).toBe(false);
    expect(anchor.held).toBe(false);
    expect(member1.held).toBe(false);
    expect(ctrl.current()).toBeNull();
  });

  test('non-anchor failure: drag proceeds with the claimable subset', () => {
    const anchor  = new FakeHandle('A', { position: [0, 0, 0] });
    const member1 = new FakeHandle('B', { position: [1, 0, 0], holdsOk: false });
    const member2 = new FakeHandle('C', { position: [0, 0, 2] });

    expect(ctrl.begin(asHandle(anchor), [asHandle(member1), asHandle(member2)], 0)).toBe(true);
    expect(member1.held).toBe(false);
    expect(member2.held).toBe(true);
    expect(ctrl.current()?.members.map(m => m.id)).toEqual(['C']);

    ctrl.applyAnchorTranslation(5, 0, 5);
    expect(member1.positions.length).toBe(0);
    expect(member2.positions.at(-1)).toEqual([5, 0, 7]);
  });

  test('release distributes shared velocity to anchor + members and clears state', () => {
    const anchor  = new FakeHandle('A');
    const member1 = new FakeHandle('B', { position: [1, 0, 0] });
    ctrl.begin(asHandle(anchor), [asHandle(member1)], 0);

    ctrl.release({ vx: 3, vy: 0, vz: 1 });
    expect(anchor.released).toBe(true);
    expect(anchor.lastReleaseVelocity).toEqual({ vx: 3, vy: 0, vz: 1 });
    expect(member1.released).toBe(true);
    expect(member1.lastReleaseVelocity).toEqual({ vx: 3, vy: 0, vz: 1 });
    expect(ctrl.current()).toBeNull();
  });

  test('release with no velocity passes undefined to each handle', () => {
    const anchor  = new FakeHandle('A');
    const member1 = new FakeHandle('B', { position: [1, 0, 0] });
    ctrl.begin(asHandle(anchor), [asHandle(member1)], 0);

    ctrl.release();
    expect(anchor.lastReleaseVelocity).toBeUndefined();
    expect(member1.lastReleaseVelocity).toBeUndefined();
  });

  test('applyAnchorTranslation is a no-op before begin / after release', () => {
    const member = new FakeHandle('B');
    ctrl.applyAnchorTranslation(1, 0, 1);
    expect(member.positions).toEqual([]);
  });
});

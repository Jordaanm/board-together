// @vitest-environment jsdom
//
// Issue #2 of issues--multiselect.md — GrabTool reads Shift/Ctrl from the
// pointer event and forwards a `SelectionClickModifier` into onSelect. The
// pure click-matrix lives in `applySelectionClick`; this file just verifies
// the tool wires modifier capture + dispatch correctly.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { GrabTool } from './GrabTool';
import { AxisGizmoAttachment } from './AxisGizmoAttachment';
import { HitboxAttachment } from './HitboxAttachment';
import { DropPreviewGhost } from './DropPreviewGhost';
import { MoveGizmo } from '../../scene/MoveGizmo';
import { Entity } from '../../entity/Entity';
import { type ToolContext, type ToolPointerEvent } from './types';
import { type World } from '../../entity/world';
import { type SelectionClickModifier } from '../SelectionStore';

class FakeHandle {
  entity: Entity;
  obj:    THREE.Object3D;

  constructor(public id: string) {
    this.obj = new THREE.Mesh(new THREE.BoxGeometry(1, 0.3, 1));
    this.entity = new Entity({ id, type: 'die', name: id });
  }

  get(cls: { typeId: string }): unknown {
    if (cls.typeId === 'transform') return { object3d: this.obj };
    return undefined;
  }
  canStartDrag(): boolean { return true; }
  tryHold(): boolean { return true; }
  heldBy(): null { return null; }
  release(): void {}
  setPosition(): void {}
}

function makeWorld(handles: FakeHandle[]): World {
  return {
    forEach(fn: (h: FakeHandle) => void) { for (const h of handles) fn(h); },
    pickByObject3D(obj: THREE.Object3D): FakeHandle | undefined {
      let cur: THREE.Object3D | null = obj;
      while (cur) {
        for (const h of handles) if (h.obj === cur) return h;
        cur = cur.parent;
      }
      return undefined;
    },
    get(id: string): FakeHandle | undefined { return handles.find(h => h.id === id); },
  } as unknown as World;
}

function pointerEvent(opts: {
  worldX?:   number; worldZ?: number;
  clientX?:  number; clientY?: number;
  shiftKey?: boolean; ctrlKey?: boolean;
} = {}): ToolPointerEvent {
  const wx = opts.worldX ?? 0;
  const wz = opts.worldZ ?? 0;
  return {
    pointerId: 1,
    button:    0,
    clientX:   opts.clientX ?? 0,
    clientY:   opts.clientY ?? 0,
    ndc:       new THREE.Vector2(),
    ray:       new THREE.Ray(new THREE.Vector3(wx, 5, wz), new THREE.Vector3(0, -1, 0)),
    timestamp: 0,
    shiftKey:  opts.shiftKey ?? false,
    ctrlKey:   opts.ctrlKey ?? false,
    altKey:    false,
  };
}

describe('GrabTool — modifier-key click forwarding', () => {
  let scene:    THREE.Scene;
  let element:  HTMLElement;
  let calls:    Array<{ id: string | null; modifier: SelectionClickModifier }>;
  let tool:     GrabTool;
  let die:      FakeHandle;
  let ctx:      ToolContext;

  beforeEach(() => {
    scene = new THREE.Scene();
    element = document.createElement('div');
    element.setPointerCapture = () => {};
    document.body.appendChild(element);

    const moveGizmo = new MoveGizmo();
    calls = [];
    tool = new GrabTool(
      moveGizmo,
      new AxisGizmoAttachment(scene, moveGizmo),
      new HitboxAttachment(scene),
      new DropPreviewGhost(scene),
      (id, modifier) => calls.push({ id, modifier }),
    );

    die = new FakeHandle('die-1');
    scene.add(die.obj);
    const world = makeWorld([die]);
    ctx = {
      world, scene,
      camera:      new THREE.PerspectiveCamera(),
      element,
      raycaster:   new THREE.Raycaster(),
      getSelfSeat: () => 0,
    };
    tool.onActivate(ctx);
  });

  afterEach(() => { document.body.innerHTML = ''; });

  test('plain click → modifier=plain', () => {
    tool.onPress(pointerEvent({}), ctx);
    tool.onRelease(pointerEvent({}), ctx);
    expect(calls).toEqual([{ id: 'die-1', modifier: 'plain' }]);
  });

  test('Shift+Click → modifier=shift', () => {
    tool.onPress(pointerEvent({ shiftKey: true }), ctx);
    tool.onRelease(pointerEvent({ shiftKey: true }), ctx);
    expect(calls).toEqual([{ id: 'die-1', modifier: 'shift' }]);
  });

  test('Ctrl+Click → modifier=ctrl', () => {
    tool.onPress(pointerEvent({ ctrlKey: true }), ctx);
    tool.onRelease(pointerEvent({ ctrlKey: true }), ctx);
    expect(calls).toEqual([{ id: 'die-1', modifier: 'ctrl' }]);
  });

  test('empty-space plain click → modifier=plain, id=null', () => {
    // No mesh under the press ray.
    const world = makeWorld([]);
    const ctx2: ToolContext = { ...ctx, world };
    tool.onPress(pointerEvent({}), ctx2);
    tool.onRelease(pointerEvent({}), ctx2);
    expect(calls).toEqual([{ id: null, modifier: 'plain' }]);
  });

  test('Shift+Click on empty space carries modifier=shift', () => {
    const world = makeWorld([]);
    const ctx2: ToolContext = { ...ctx, world };
    tool.onPress(pointerEvent({ shiftKey: true }), ctx2);
    tool.onRelease(pointerEvent({ shiftKey: true }), ctx2);
    expect(calls).toEqual([{ id: null, modifier: 'shift' }]);
  });
});

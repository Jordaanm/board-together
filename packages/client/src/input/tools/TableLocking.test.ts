// @vitest-environment jsdom
//
// Slice 5 of issues--table-refactor.md — UI-side locking enforcement for
// the singleton Table entity:
//   * GrabTool short-press on the Table mesh clears prior selection rather
//     than selecting the Table or carrying it.
//   * AxisGizmoAttachment.attach() is a no-op for a Table-bearing handle.
//   * ContextMenuController.builtinHostActions emits no Delete for the Table.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { GrabTool } from './GrabTool';
import { AxisGizmoAttachment } from './AxisGizmoAttachment';
import { MarqueeOverlay } from './MarqueeOverlay';
import { RotateGizmo } from '../../scene/RotateGizmo';
import { HitboxAttachment } from './HitboxAttachment';
import { DropPreviewGhost } from './DropPreviewGhost';
import { MoveGizmo } from '../../scene/MoveGizmo';
import { Entity } from '../../entity/Entity';
import { TableComponent } from '../../entity/components/TableComponent';
import { type ToolContext, type ToolPointerEvent } from './types';
import { type EntityHandle, type World } from '../../entity/world';
import { builtinHostActions, ContextMenuController, type ContextMenuRequest } from '../ContextMenuController';

class FakeHandle {
  entity: Entity;
  obj:    THREE.Object3D;

  constructor(public id: string, opts: { table?: boolean } = {}) {
    this.obj = new THREE.Mesh(new THREE.BoxGeometry(1, 0.3, 1));
    this.entity = new Entity({ id, type: opts.table ? 'table' : 'die', name: id });
    if (opts.table) {
      const t = new TableComponent();
      t.state = {};
      this.entity.attachComponent(t);
    }
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
  worldX?: number; worldZ?: number;
  clientX?: number; clientY?: number;
  pointerId?: number;
} = {}): ToolPointerEvent {
  const wx = opts.worldX ?? 0;
  const wz = opts.worldZ ?? 0;
  return {
    pointerId: opts.pointerId ?? 1,
    button:    0,
    clientX:   opts.clientX ?? 0,
    clientY:   opts.clientY ?? 0,
    ndc:       new THREE.Vector2(),
    ray:       new THREE.Ray(new THREE.Vector3(wx, 5, wz), new THREE.Vector3(0, -1, 0)),
    timestamp: 0,
    shiftKey: false, ctrlKey: false, altKey: false,
  };
}

describe('GrabTool — Table click-through (slice 5)', () => {
  let scene:    THREE.Scene;
  let element:  HTMLElement;
  let selectCalls: Array<string | null>;
  let tool:     GrabTool;
  let table:    FakeHandle;
  let world:    World;
  let ctx:      ToolContext;

  beforeEach(() => {
    scene = new THREE.Scene();
    element = document.createElement('div');
    element.setPointerCapture = () => {};
    document.body.appendChild(element);

    const moveGizmo  = new MoveGizmo();
    const rotateGizmo = new RotateGizmo();
    const attachment = new AxisGizmoAttachment(scene, moveGizmo, rotateGizmo);
    const hitboxAttachment = new HitboxAttachment(scene);
    const dropPreviewGhost = new DropPreviewGhost(scene);
    selectCalls = [];
    tool = new GrabTool(
      moveGizmo, rotateGizmo, attachment, hitboxAttachment, dropPreviewGhost,
      new MarqueeOverlay(element),
      (id: string | null) => selectCalls.push(id),
      () => {},
    );

    table = new FakeHandle('table-1', { table: true });
    scene.add(table.obj);
    world = makeWorld([table]);
    ctx = {
      world, scene,
      camera:      new THREE.PerspectiveCamera(),
      element,
      raycaster:   new THREE.Raycaster(),
      getSelfSeat: () => 0,
    };
    tool.onActivate(ctx);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('short-press on the Table mesh clears selection (treated as empty click)', () => {
    tool.onPress(pointerEvent({}), ctx);
    tool.onRelease(pointerEvent({}), ctx);
    expect(selectCalls).toEqual([null]);
  });

  test('press-then-move on the Table never starts a carry', () => {
    tool.onPress(pointerEvent({ clientX: 0, clientY: 0 }), ctx);
    tool.onMove (pointerEvent({ clientX: 50, clientY: 50 }), ctx);
    tool.onRelease(pointerEvent({ clientX: 50, clientY: 50 }), ctx);
    // Empty-click branch only fires onSelect when no movement; with movement
    // the gesture is just dropped. Either way: no selection of the Table.
    expect(selectCalls).not.toContain('table-1');
  });
});

describe('AxisGizmoAttachment — skips Table (slice 5)', () => {
  let scene:      THREE.Scene;
  let attachment: AxisGizmoAttachment;
  let ctx:        ToolContext;

  beforeEach(() => {
    scene = new THREE.Scene();
    attachment = new AxisGizmoAttachment(scene, new MoveGizmo(), new RotateGizmo());
    ctx = {
      world: makeWorld([]),
      scene,
      camera:      new THREE.PerspectiveCamera(),
      element:     document.createElement('div'),
      raycaster:   new THREE.Raycaster(),
      getSelfSeat: () => 0,
    };
  });

  test('attach() is a no-op when the handle has TableComponent', () => {
    const table = new FakeHandle('table-1', { table: true });
    attachment.attach(table as unknown as EntityHandle, ctx);
    expect(attachment.isAttached()).toBe(false);
  });

  test('attach() works on a non-Table entity', () => {
    const die = new FakeHandle('die-1');
    scene.add(die.obj);
    attachment.attach(die as unknown as EntityHandle, ctx);
    expect(attachment.isAttached()).toBe(true);
  });
});

describe('ContextMenuController — Table suppresses Delete (slice 5)', () => {
  test('builtinHostActions returns empty for a Table entity', () => {
    const e = new Entity({ id: 't', type: 'table', name: 't' });
    const tc = new TableComponent();
    tc.state = {};
    e.attachComponent(tc);
    expect(builtinHostActions(e)).toEqual([]);
  });

  test('builtinHostActions returns Duplicate + Delete for a non-Table entity', () => {
    const e = new Entity({ id: 'd', type: 'die', name: 'd' });
    const items = builtinHostActions(e);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'action', id: '__duplicate' });
    expect(items[1]).toMatchObject({ kind: 'action', id: '__delete' });
  });
});

describe('ContextMenuController — right-click on Table opens no menu', () => {
  test('onOpen never fires when the contextmenu hit is a Table-bearing handle', () => {
    const element = document.createElement('div');
    Object.defineProperty(element, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) }),
    });
    document.body.appendChild(element);

    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 5, 0);
    camera.lookAt(0, 0, 0);

    const table = new FakeHandle('table-1', { table: true });
    const world = makeWorld([table]);

    const opens: ContextMenuRequest[] = [];
    const controller = new ContextMenuController(
      element, camera, /* isHost */ true, world, () => 0, (req) => opens.push(req),
    );

    element.dispatchEvent(new MouseEvent('contextmenu', { clientX: 50, clientY: 50, bubbles: true }));

    expect(opens).toEqual([]);
    controller.dispose();
    document.body.innerHTML = '';
  });
});

// @vitest-environment jsdom
//
// GrabTool — throw velocity threshold + ghost gating. Issue #4 of
// planning/issues--drag-refactor.md.
//
// Verifies the release branch: above `THROW_VELOCITY_THRESHOLD` the throw
// velocity is applied; below, the body is released with no velocity. Also
// verifies the per-frame ghost-visibility predicate (cursor velocity below
// threshold AND resolver returned a bare surface → ghost shown; otherwise
// hidden).

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { GrabTool } from './GrabTool';
import { AxisGizmoAttachment } from './AxisGizmoAttachment';
import { MarqueeOverlay } from './MarqueeOverlay';
import { RotateGizmo } from '../../scene/RotateGizmo';
import { HitboxAttachment } from './HitboxAttachment';
import { DropPreviewGhost } from './DropPreviewGhost';
import { MoveGizmo } from '../../scene/MoveGizmo';
import { type Entity } from '../../entity/Entity';
import { type ToolContext, type ToolPointerEvent } from './types';
import { type EntityHandle, type World } from '../../entity/world';
import { type SeatIndex } from '../../seats/SeatLayout';
import { clearDropTargets } from '../dropTargetRegistry';

interface ReleaseCall { vx?: number; vy?: number; vz?: number }

class FakeHandle {
  releases: ReleaseCall[] = [];
  entity: Entity;
  obj: THREE.Object3D;

  constructor(public id: string, position: [number, number, number] = [0, 0.5, 0]) {
    this.obj = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.7));
    this.obj.position.set(position[0], position[1], position[2]);
    this.obj.updateMatrixWorld(true);
    this.entity = {
      id, type: 'card', name: id, tags: ['card'],
      owner: null, privateToSeat: null, parentId: null, children: [],
      heldBy: null, components: new Map(), scene: null,
      getComponent: (cls: { typeId: string }) => cls.typeId === 'transform'
        ? ({ object3d: this.obj, state: { position: [this.obj.position.x, this.obj.position.y, this.obj.position.z], rotation: [0,0,0,1], scale: [1,1,1] } } as unknown)
        : undefined,
      hasComponent: () => false,
      tryGrab: () => ({ kind: 'self' as const }),
    } as unknown as Entity;
  }

  get(cls: { typeId: string }): unknown {
    if (cls.typeId === 'transform') return { object3d: this.obj };
    if (cls.typeId === 'physics')   return { body: { position: this.obj.position }, state: { isLocked: false } };
    return undefined;
  }

  canStartDrag(): boolean { return true; }
  tryHold(seat: SeatIndex): boolean { this.entity.heldBy = seat; return true; }
  heldBy(): SeatIndex | null { return this.entity.heldBy; }
  release(velocity?: { vx: number; vy: number; vz: number }): void {
    this.releases.push(velocity ?? {});
    this.entity.heldBy = null;
  }
  setPosition(x: number, y: number, z: number): void {
    this.obj.position.set(x, y, z);
    this.obj.updateMatrixWorld(true);
  }
}

class SpyGhost extends DropPreviewGhost {
  updates: (number | null)[] = [];
  override update(surfaceY: number | null): void {
    this.updates.push(surfaceY);
    super.update(surfaceY);
  }
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

function makeCtx(world: World, scene: THREE.Scene, element: HTMLElement): ToolContext {
  return {
    world, scene,
    camera:      new THREE.PerspectiveCamera(),
    element,
    raycaster:   new THREE.Raycaster(),
    getSelfSeat: () => 0,
  };
}

function pointerEvent(opts: {
  worldX?: number; worldZ?: number;
  clientX?: number; clientY?: number;
  timestamp?: number;
} = {}): ToolPointerEvent {
  const wx = opts.worldX ?? 0;
  const wz = opts.worldZ ?? 0;
  return {
    pointerId: 1,
    button:    0,
    clientX:   opts.clientX   ?? 0,
    clientY:   opts.clientY   ?? 0,
    ndc:       new THREE.Vector2(),
    ray:       new THREE.Ray(new THREE.Vector3(wx, 5, wz), new THREE.Vector3(0, -1, 0)),
    timestamp: opts.timestamp ?? 0,
    shiftKey:  false, ctrlKey: false, altKey: false,
  };
}

let tool:    GrabTool;
let scene:   THREE.Scene;
let canvas:  HTMLElement;
let dragged: FakeHandle;
let table:   FakeHandle;
let world:   World;
let ctx:     ToolContext;
let ghost:   SpyGhost;

beforeEach(() => {
  scene  = new THREE.Scene();
  canvas = document.createElement('div');
  canvas.setPointerCapture = () => {};
  document.body.appendChild(canvas);
  // jsdom doesn't implement elementFromPoint; GrabTool's release branch
  // calls it through findDropTargetAt to look up hand-panel targets.
  document.elementFromPoint = (() => null) as Document['elementFromPoint'];

  const moveGizmo  = new MoveGizmo();
  const rotateGizmo = new RotateGizmo();
  const attachment = new AxisGizmoAttachment(scene, moveGizmo, rotateGizmo);
  const hitboxAttachment = new HitboxAttachment(scene);
  ghost = new SpyGhost(scene);
  tool  = new GrabTool(
    moveGizmo, rotateGizmo, attachment, hitboxAttachment, ghost,
    new MarqueeOverlay(canvas),
    () => {},
    () => {},
  );

  dragged = new FakeHandle('card-1', [0, 0.5, 0]);
  // A large flat "table" mesh under the cursor path so the resolver returns
  // bare hits and the ghost can be visible.
  table = new FakeHandle('table-1', [0, 0, 0]);
  table.obj.geometry.dispose();
  table.obj.geometry = new THREE.BoxGeometry(10, 0.2, 10);
  table.obj.updateMatrixWorld(true);
  scene.add(dragged.obj);
  scene.add(table.obj);
  world = makeWorld([dragged, table]);
  ctx   = makeCtx(world, scene, canvas);
  tool.onActivate(ctx);
});

afterEach(() => {
  clearDropTargets();
  document.body.innerHTML = '';
});

describe('GrabTool — slow release (gravity-drop) vs fast release (throw)', () => {
  test('slow release: no throw velocity applied, body returns to DYNAMIC implicitly', () => {
    tool.onPress(pointerEvent({ timestamp: 0 }), ctx);
    tool.onMove (pointerEvent({ timestamp:   50, clientX: 100, clientY: 100, worldX: 1 }), ctx);
    tool.update(0.016, ctx);  // carry → active
    // Stationary samples within the throw window — cursor speed stays well
    // below the threshold.
    tool.onMove (pointerEvent({ timestamp: 1000, clientX: 100, clientY: 100, worldX: 1 }), ctx);
    tool.onMove (pointerEvent({ timestamp: 1050, clientX: 100, clientY: 100, worldX: 1.001 }), ctx);
    tool.onRelease(pointerEvent({ timestamp: 1100, clientX: 100, clientY: 100 }), ctx);

    expect(dragged.releases).toHaveLength(1);
    expect(dragged.releases[0]).toEqual({});  // no velocity object → gravity drop
  });

  test('fast release: throw velocity is applied (existing flick behaviour preserved)', () => {
    tool.onPress(pointerEvent({ timestamp: 0 }), ctx);
    tool.onMove (pointerEvent({ timestamp:  50, clientX: 100, clientY: 100, worldX: 1 }), ctx);
    tool.update(0.016, ctx);
    // Fast cursor sweep within the throw-velocity window: 4 units / 40ms = 100 u/s.
    tool.onMove (pointerEvent({ timestamp: 150, clientX: 110, clientY: 100, worldX: 1 }), ctx);
    tool.onMove (pointerEvent({ timestamp: 190, clientX: 200, clientY: 100, worldX: 5 }), ctx);
    tool.onRelease(pointerEvent({ timestamp: 200, clientX: 200, clientY: 100 }), ctx);

    expect(dragged.releases).toHaveLength(1);
    const rel = dragged.releases[0];
    expect(rel).toHaveProperty('vx');
    expect(rel).toHaveProperty('vy');
    expect(rel).toHaveProperty('vz');
    expect(Math.abs(rel.vx ?? 0)).toBeGreaterThan(0);
  });
});

describe('GrabTool — ghost gating on cursor speed', () => {
  test('slow cursor over a bare surface: ghost.update called with the surfaceY', () => {
    tool.onPress(pointerEvent({ timestamp: 0, worldX: 0, worldZ: 0 }), ctx);
    tool.onMove (pointerEvent({ timestamp:  50, clientX: 100, clientY: 100, worldX: 0.01, worldZ: 0 }), ctx);
    tool.update(0.016, ctx);
    // Stationary samples — cursor speed stays at 0.
    tool.onMove (pointerEvent({ timestamp: 1000, clientX: 100, clientY: 100, worldX: 0.01, worldZ: 0 }), ctx);
    tool.onMove (pointerEvent({ timestamp: 1050, clientX: 100, clientY: 100, worldX: 0.015, worldZ: 0 }), ctx);
    tool.update(0.016, ctx);

    // Last surfaceY the ghost received should be the table's top (0 + halfY=0.1).
    const last = ghost.updates[ghost.updates.length - 1];
    expect(last).not.toBeNull();
    expect(last as number).toBeCloseTo(0.1, 2);
  });

  test('fast cursor: ghost.update called with null (hidden)', () => {
    tool.onPress(pointerEvent({ timestamp: 0, worldX: 0, worldZ: 0 }), ctx);
    tool.onMove (pointerEvent({ timestamp:  50, clientX: 100, clientY: 100, worldX: 0.01, worldZ: 0 }), ctx);
    tool.update(0.016, ctx);
    // Fast cursor sweep: 4 units / 40ms = 100 u/s → well above threshold.
    tool.onMove (pointerEvent({ timestamp: 150, clientX: 110, clientY: 100, worldX: 0.01, worldZ: 0 }), ctx);
    tool.onMove (pointerEvent({ timestamp: 190, clientX: 200, clientY: 100, worldX: 4, worldZ: 0 }), ctx);
    tool.update(0.016, ctx);

    const last = ghost.updates[ghost.updates.length - 1];
    expect(last).toBeNull();
  });
});

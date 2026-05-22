// @vitest-environment jsdom
//
// GrabTool release-over-drop-target branch — issue #7 of issues--hand.md.
// Validates that when the cursor at release lies over a registered drop
// target, the carry path skips throw-velocity and routes the entity into
// the destination hand via `world.tweenIntoHand`.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { GrabTool } from './GrabTool';
import { AxisGizmoAttachment } from './AxisGizmoAttachment';
import { HitboxAttachment } from './HitboxAttachment';
import { DropPreviewGhost } from './DropPreviewGhost';
import { MoveGizmo } from '../../scene/MoveGizmo';
import { type Entity } from '../../entity/Entity';
import { type ToolContext, type ToolPointerEvent } from './types';
import { type EntityHandle, type World } from '../../entity/world';
import { type SeatIndex } from '../../seats/SeatLayout';
import { TransformComponent } from '../../entity/components/TransformComponent';
import { registerDropTarget, clearDropTargets } from '../dropTargetRegistry';

interface ReleaseCall { vx?: number; vy?: number; vz?: number }
interface TweenIntoHandCall { entityId: string; handEntityId: string }

class FakeHandle {
  releases: ReleaseCall[] = [];
  entity: Entity;
  obj: THREE.Object3D;

  constructor(public id: string) {
    this.obj = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.7));
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
    if (cls.typeId === 'physics') return { body: { position: this.obj.position }, state: { isLocked: false } };
    return undefined;
  }

  canStartDrag(): boolean { return true; }
  tryHold(seat: SeatIndex): boolean { this.entity.heldBy = seat; return true; }
  heldBy(): SeatIndex | null { return this.entity.heldBy; }
  release(velocity?: { vx: number; vy: number; vz: number }): void {
    this.releases.push(velocity ?? {});
    this.entity.heldBy = null;
  }
  setPosition(x: number, y: number, z: number): void { this.obj.position.set(x, y, z); }
}

function makeWorld(handles: FakeHandle[]): { world: World; tweenCalls: TweenIntoHandCall[] } {
  const tweenCalls: TweenIntoHandCall[] = [];
  const world = {
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
    tweenIntoHand(entity: Entity, handEntityId: string) {
      tweenCalls.push({ entityId: entity.id, handEntityId });
    },
  } as unknown as World;
  return { world, tweenCalls };
}

function makeCtx(world: World, camera: THREE.PerspectiveCamera, scene: THREE.Scene, element: HTMLElement): ToolContext {
  return {
    world, scene, camera, element,
    raycaster:   new THREE.Raycaster(),
    getSelfSeat: () => 0,
  };
}

function pointerEvent(opts: {
  worldX?: number; worldZ?: number;
  clientX?: number; clientY?: number;
  timestamp?: number; pointerId?: number; button?: number;
} = {}): ToolPointerEvent {
  const wx = opts.worldX ?? 0;
  const wz = opts.worldZ ?? 0;
  return {
    pointerId: opts.pointerId ?? 1,
    button:    opts.button    ?? 0,
    clientX:   opts.clientX   ?? 0,
    clientY:   opts.clientY   ?? 0,
    ndc:       new THREE.Vector2(),
    ray:       new THREE.Ray(new THREE.Vector3(wx, 5, wz), new THREE.Vector3(0, -1, 0)),
    timestamp: opts.timestamp ?? 0,
    shiftKey:  false, ctrlKey: false, altKey: false,
  };
}

let tool:    GrabTool;
let handle:  FakeHandle;
let world:   World;
let scene:   THREE.Scene;
let camera:  THREE.PerspectiveCamera;
let canvas:  HTMLElement;
let ctx:     ToolContext;
let tweenCalls: TweenIntoHandCall[];

beforeEach(() => {
  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera();
  canvas = document.createElement('div');
  canvas.setPointerCapture = () => {};
  document.body.appendChild(canvas);

  const moveGizmo = new MoveGizmo();
  const attachment = new AxisGizmoAttachment(scene, moveGizmo);
  const hitboxAttachment = new HitboxAttachment(scene);
  const dropPreviewGhost = new DropPreviewGhost(scene);
  tool = new GrabTool(moveGizmo, attachment, hitboxAttachment, dropPreviewGhost, () => {});

  handle = new FakeHandle('card-1');
  scene.add(handle.obj);
  ({ world, tweenCalls } = makeWorld([handle]));
  ctx = makeCtx(world, camera, scene, canvas);
  tool.onActivate(ctx);
});

afterEach(() => {
  clearDropTargets();
  document.body.innerHTML = '';
});

function performCarry(opts: {
  releaseClientX:   number;
  releaseClientY:   number;
  releaseTimestamp: number;
}) {
  // Press, drag past 5px to enter carry, then release.
  tool.onPress(pointerEvent({ timestamp: 0 }), ctx);
  tool.onMove (pointerEvent({ timestamp: 50, clientX: 100, clientY: 100, worldX: 1 }), ctx);
  tool.update(0.016, ctx);  // flips carry.active true
  tool.onRelease(pointerEvent({
    clientX: opts.releaseClientX, clientY: opts.releaseClientY, timestamp: opts.releaseTimestamp,
  }), ctx);
}

describe('GrabTool — release over a registered hand-panel drop target', () => {
  test('releasing over the panel calls world.tweenIntoHand and skips throw velocity', () => {
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    registerDropTarget(panel, { kind: 'hand-panel', handEntityId: 'h-target' });
    document.elementFromPoint = (() => panel) as Document['elementFromPoint'];

    performCarry({ releaseClientX: 50, releaseClientY: 60, releaseTimestamp: 200 });

    expect(tweenCalls).toEqual([{ entityId: 'card-1', handEntityId: 'h-target' }]);
    expect(handle.releases).toHaveLength(1);
    expect(handle.releases[0]).toEqual({}); // released without velocity
  });

  test('releasing away from any drop target uses throw-velocity release', () => {
    document.elementFromPoint = (() => null) as Document['elementFromPoint'];

    performCarry({ releaseClientX: 700, releaseClientY: 700, releaseTimestamp: 200 });

    expect(tweenCalls).toHaveLength(0);
    expect(handle.releases).toHaveLength(1);
    // Throw release carries velocity fields (may be 0, but the object shape
    // includes vx / vy / vz unlike the no-velocity drop case).
    expect(handle.releases[0]).toHaveProperty('vx');
    expect(handle.releases[0]).toHaveProperty('vy');
    expect(handle.releases[0]).toHaveProperty('vz');
  });

  test('releasing over an unregistered element uses throw-velocity release', () => {
    const stranger = document.createElement('div');
    document.body.appendChild(stranger);
    document.elementFromPoint = (() => stranger) as Document['elementFromPoint'];

    performCarry({ releaseClientX: 50, releaseClientY: 60, releaseTimestamp: 200 });

    expect(tweenCalls).toHaveLength(0);
    expect(handle.releases).toHaveLength(1);
    expect(handle.releases[0]).toHaveProperty('vx');
  });
});

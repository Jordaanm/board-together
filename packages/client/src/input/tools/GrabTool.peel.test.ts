// @vitest-environment jsdom
//
// GrabTool short-press peel — issue #2 of issues--deck-peel.md.
// Exercises the new commit-time branch: short-press-then-move on a deck
// invokes World.peelAndHold; on resolution + entity-arrival, the tool
// transitions into a normal Carry on the peeled card. Long-press on a deck
// still takes the existing tryHold path. Short-press on a non-deck entity
// still takes the existing self-carry path.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { GrabTool } from './GrabTool';
import { AxisGizmoAttachment } from './AxisGizmoAttachment';
import { RotateGizmo } from '../../scene/RotateGizmo';
import { HitboxAttachment } from './HitboxAttachment';
import { DropPreviewGhost } from './DropPreviewGhost';
import { MoveGizmo } from '../../scene/MoveGizmo';
import { Entity } from '../../entity/Entity';
import { EntityComponent, type GrabIntent } from '../../entity/EntityComponent';
import { type ToolContext, type ToolPointerEvent } from './types';
import { type World } from '../../entity/world';
import { type PeelAndHoldResult } from '../../entity/wire';
import { type SeatIndex } from '../../seats/SeatLayout';
import { componentRegistry } from '../../entity/ComponentRegistry';
import { clearDropTargets } from '../dropTargetRegistry';

// Minimal stand-in for DeckComponent so the registry can resolve 'deck'
// without dragging in the full transform/mesh/physics dependency chain.
// Matches the real DeckComponent.onTryGrab branching (long → null, empty →
// null, otherwise → peel intent).
class StubDeck extends EntityComponent<{ cards: string[] }> {
  static typeId   = 'deck';
  static requires = [] as const;
  onSpawn() {}
  onPropertiesChanged() {}
  onTryGrab(isLongPress: boolean): GrabIntent | null {
    if (isLongPress)                    return null;
    if (this.state.cards.length === 0)  return null;
    return { kind: 'peel', sourceId: this.entity.id };
  }
}

interface PeelCall {
  deckId: string;
  seat:   SeatIndex;
}
interface ReleaseCall { vx?: number; vy?: number; vz?: number }

class FakeHandle {
  entity: Entity;
  obj: THREE.Object3D;
  released: ReleaseCall[] = [];
  holds:    SeatIndex[]   = [];

  // Optional override so tests can simulate a deck whose owner refuses
  // manipulation (spectator viewer, locked-owner non-owner) — both surface
  // through this single gate.
  private canStartDragValue = true;

  constructor(public id: string, kind: 'deck' | 'card' | 'die', position: [number, number, number] = [0, 0.5, 0]) {
    this.obj = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.7));
    this.obj.position.set(position[0], position[1], position[2]);
    this.entity = new Entity({ id, type: kind, name: id });
    if (kind === 'deck') {
      const c = new StubDeck();
      c.state = { cards: ['c-1', 'c-2', 'c-3'] };
      c.entity = this.entity;
      this.entity.components.set('deck', c);
    }
  }

  setCanStartDrag(v: boolean): void { this.canStartDragValue = v; }

  get(cls: { typeId: string }): unknown {
    if (cls.typeId === 'transform') return { object3d: this.obj, state: { position: [this.obj.position.x, this.obj.position.y, this.obj.position.z], rotation: [0,0,0,1], scale: [1,1,1] } };
    if (cls.typeId === 'physics')   return { body: { position: this.obj.position }, state: { isLocked: false } };
    return undefined;
  }

  canStartDrag(): boolean { return this.canStartDragValue; }
  tryHold(seat: SeatIndex): boolean { this.entity.heldBy = seat; this.holds.push(seat); return true; }
  heldBy(): SeatIndex | null { return this.entity.heldBy; }
  release(velocity?: ReleaseCall): void {
    this.released.push(velocity ?? {});
    this.entity.heldBy = null;
  }
  setPosition(x: number, y: number, z: number): void { this.obj.position.set(x, y, z); }
}

interface FakeWorldHandle {
  peelCalls:     PeelCall[];
  resolvePeel:   (result: PeelAndHoldResult | null) => void;
  // When > 0, peelAndHold defers resolution until resolvePeel is called.
  // Otherwise the next peelAndHold resolves synchronously with `nextResult`.
  setDeferred:   (deferred: boolean) => void;
  setNextResult: (r: PeelAndHoldResult | null) => void;
}

function makeWorld(handles: FakeHandle[]): { world: World; fake: FakeWorldHandle } {
  const peelCalls: PeelCall[] = [];
  let deferred = false;
  let pendingResolve: ((r: PeelAndHoldResult | null) => void) | null = null;
  let nextResult: PeelAndHoldResult | null = null;

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
    peelAndHold(deckId: string, seat: SeatIndex): Promise<PeelAndHoldResult | null> {
      peelCalls.push({ deckId, seat });
      if (!deferred) return Promise.resolve(nextResult);
      return new Promise((resolve) => { pendingResolve = resolve; });
    },
  } as unknown as World;

  const fake: FakeWorldHandle = {
    peelCalls,
    resolvePeel: (result) => {
      if (pendingResolve) {
        pendingResolve(result);
        pendingResolve = null;
      }
    },
    setDeferred:   (d) => { deferred = d; },
    setNextResult: (r) => { nextResult = r; },
  };
  return { world, fake };
}

function makeCtx(world: World, camera: THREE.PerspectiveCamera, scene: THREE.Scene, element: HTMLElement, seat: SeatIndex | null = 0): ToolContext {
  return {
    world, scene, camera, element,
    raycaster:   new THREE.Raycaster(),
    getSelfSeat: () => seat,
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

// Helper to wait for promise microtasks to drain.
const flush = () => Promise.resolve().then(() => Promise.resolve());

let tool:   GrabTool;
let scene:  THREE.Scene;
let camera: THREE.PerspectiveCamera;
let canvas: HTMLElement;

beforeEach(() => {
  // Entity.tryGrab walks componentRegistry.getSpawnOrder for the entity's
  // typeIds. Register the StubDeck so 'deck' resolves cleanly without
  // pulling in transform/mesh/physics dependencies.
  componentRegistry.clear();
  componentRegistry.register(StubDeck);

  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera();
  canvas = document.createElement('div');
  canvas.setPointerCapture = () => {};
  document.body.appendChild(canvas);

  const moveGizmo  = new MoveGizmo();
  const rotateGizmo = new RotateGizmo();
  const attachment = new AxisGizmoAttachment(scene, moveGizmo, rotateGizmo);
  const hitboxAttachment = new HitboxAttachment(scene);
  const dropPreviewGhost = new DropPreviewGhost(scene);
  tool = new GrabTool(moveGizmo, rotateGizmo, attachment, hitboxAttachment, dropPreviewGhost, () => {});
});

afterEach(() => {
  clearDropTargets();
  componentRegistry.clear();
  document.body.innerHTML = '';
});

describe('GrabTool — short-press peel on a deck', () => {
  test('short-press-then-move on a deck invokes peelAndHold and transitions to Carry on reply + entity-arrival', async () => {
    const deck = new FakeHandle('deck-1', 'deck', [0, 0.5, 0]);
    const card = new FakeHandle('card-1', 'card', [0, 0.5, 0]);
    scene.add(deck.obj);
    const { world, fake } = makeWorld([deck, card]);
    fake.setDeferred(true);
    const ctx = makeCtx(world, camera, scene, canvas);
    tool.onActivate(ctx);

    const t0 = performance.now();
    tool.onPress(pointerEvent({ timestamp: t0 }), ctx);
    tool.onMove(pointerEvent({ timestamp: t0 + 20, clientX: 100, clientY: 100, worldX: 1 }), ctx);

    // RPC fired, no Carry yet.
    expect(fake.peelCalls).toEqual([{ deckId: 'deck-1', seat: 0 }]);
    expect(deck.holds).toEqual([]);  // long-press path not taken
    expect(card.holds).toEqual([]);

    // Host's reply arrives with the new card id + pose.
    fake.resolvePeel({ cardId: 'card-1', pos: [0, 0.5, 0], rot: [0, 0, 0, 1] });
    await flush();

    // Until the host's hold-claim echo flips card.heldBy, update() should
    // not transition.
    tool.update(0.016, ctx);
    expect(card.entity.heldBy).toBeNull();

    // Simulate the hold-claim echo arriving on the guest's scene.
    card.entity.heldBy = 0;
    tool.update(0.016, ctx);

    // setPosition was called on the card (active carry).
    // setPosition is invoked inside update() for an active carry.
    expect(card.obj.position.x).not.toBe(0);
  });

  test('long-press-then-move on a deck takes the existing tryHold path with no peelAndHold call', () => {
    const deck = new FakeHandle('deck-1', 'deck', [0, 0.5, 0]);
    scene.add(deck.obj);
    const { world, fake } = makeWorld([deck]);
    const ctx = makeCtx(world, camera, scene, canvas);
    tool.onActivate(ctx);

    // Long-press: press, then update() repeatedly until elapsed exceeds the
    // long-press threshold without moving. performance.now() is a real
    // clock here — use Date.now()-based timing by stubbing startT in the
    // tool's internal state via a tiny pause before the second update.
    tool.onPress(pointerEvent({ timestamp: performance.now() }), ctx);
    // Spin until the long-press timer has elapsed in real time.
    const deadline = performance.now() + 200;
    while (performance.now() < deadline) {
      tool.update(0.016, ctx);
    }
    tool.update(0.016, ctx);

    expect(fake.peelCalls).toEqual([]);     // peel path not taken
    expect(deck.holds).toEqual([0]);         // existing whole-deck carry path
  });

  test('short-press-then-move on a non-deck entity takes the existing self-carry path', () => {
    const die = new FakeHandle('die-1', 'die', [0, 0.5, 0]);
    scene.add(die.obj);
    const { world, fake } = makeWorld([die]);
    const ctx = makeCtx(world, camera, scene, canvas);
    tool.onActivate(ctx);

    const t0 = performance.now();
    tool.onPress(pointerEvent({ timestamp: t0 }), ctx);
    tool.onMove(pointerEvent({ timestamp: t0 + 20, clientX: 100, clientY: 100, worldX: 1 }), ctx);

    expect(fake.peelCalls).toEqual([]);
    expect(die.holds).toEqual([0]);
  });

  test('slow drag past the long-press window still peels — move-triggered carries are short-press regardless of elapsed time', () => {
    // Regression: previously beginCarry computed isLongPress from the wall
    // clock, so a drag whose first move event fired >150ms after press was
    // classified as long-press and grabbed the whole deck. Move-triggered
    // commits must always be short-press (= peel intent).
    const deck = new FakeHandle('deck-1', 'deck', [0, 0.5, 0]);
    scene.add(deck.obj);
    const { world, fake } = makeWorld([deck]);
    const ctx = makeCtx(world, camera, scene, canvas);
    tool.onActivate(ctx);

    const t0 = performance.now();
    tool.onPress(pointerEvent({ timestamp: t0 }), ctx);
    // Move arrives >150ms after press. No update() call in between so the
    // pending pointer is still alive when the move commits.
    tool.onMove(pointerEvent({ timestamp: t0 + 250, clientX: 100, clientY: 100, worldX: 1 }), ctx);

    expect(fake.peelCalls).toEqual([{ deckId: 'deck-1', seat: 0 }]);
    expect(deck.holds).toEqual([]);
  });

  test('host rejection (null reply) silently resets the tool — no Carry begins', async () => {
    const deck = new FakeHandle('deck-1', 'deck', [0, 0.5, 0]);
    scene.add(deck.obj);
    const { world, fake } = makeWorld([deck]);
    fake.setDeferred(true);
    const ctx = makeCtx(world, camera, scene, canvas);
    tool.onActivate(ctx);

    const t0 = performance.now();
    tool.onPress(pointerEvent({ timestamp: t0 }), ctx);
    tool.onMove(pointerEvent({ timestamp: t0 + 20, clientX: 100, clientY: 100, worldX: 1 }), ctx);
    expect(fake.peelCalls).toHaveLength(1);

    fake.resolvePeel(null);
    await flush();

    expect(deck.holds).toEqual([]);
    // No active gesture remains.
    expect(tool.hasActiveGesture()).toBe(false);
  });
});

describe('GrabTool — peel authority gating', () => {
  test('spectator (canStartDrag false) never invokes peelAndHold; tool resets silently', () => {
    const deck = new FakeHandle('deck-1', 'deck', [0, 0.5, 0]);
    deck.setCanStartDrag(false);
    scene.add(deck.obj);
    const { world, fake } = makeWorld([deck]);
    const ctx = makeCtx(world, camera, scene, canvas, null);  // spectator: null seat
    tool.onActivate(ctx);

    const t0 = performance.now();
    tool.onPress(pointerEvent({ timestamp: t0 }), ctx);
    tool.onMove(pointerEvent({ timestamp: t0 + 20, clientX: 100, clientY: 100, worldX: 1 }), ctx);

    expect(fake.peelCalls).toEqual([]);
    expect(deck.holds).toEqual([]);
    expect(tool.hasActiveGesture()).toBe(false);
  });

  test('locked-owner non-owner (canStartDrag false) never invokes peelAndHold; tool resets silently', () => {
    const deck = new FakeHandle('deck-1', 'deck', [0, 0.5, 0]);
    deck.setCanStartDrag(false);
    deck.entity.owner = 7;  // owned by someone else
    scene.add(deck.obj);
    const { world, fake } = makeWorld([deck]);
    const ctx = makeCtx(world, camera, scene, canvas, 0);  // self seat 0, not the owner
    tool.onActivate(ctx);

    const t0 = performance.now();
    tool.onPress(pointerEvent({ timestamp: t0 }), ctx);
    tool.onMove(pointerEvent({ timestamp: t0 + 20, clientX: 100, clientY: 100, worldX: 1 }), ctx);

    expect(fake.peelCalls).toEqual([]);
    expect(deck.holds).toEqual([]);
    expect(tool.hasActiveGesture()).toBe(false);
  });
});

describe('GrabTool — peel cancel-while-pending', () => {
  test('release before reply arms release-on-arrival; reply fires release on the new card id', async () => {
    const deck = new FakeHandle('deck-1', 'deck', [0, 0.5, 0]);
    const card = new FakeHandle('card-1', 'card', [0, 0.5, 0]);
    scene.add(deck.obj);
    const { world, fake } = makeWorld([deck, card]);
    fake.setDeferred(true);
    const ctx = makeCtx(world, camera, scene, canvas);
    tool.onActivate(ctx);

    const t0 = performance.now();
    tool.onPress(pointerEvent({ timestamp: t0 }), ctx);
    tool.onMove(pointerEvent({ timestamp: t0 + 20, clientX: 100, clientY: 100, worldX: 1 }), ctx);
    // User releases before reply arrives.
    tool.onRelease(pointerEvent({ timestamp: t0 + 30, clientX: 100, clientY: 100 }), ctx);

    expect(card.released).toEqual([]);  // nothing released yet — no card yet

    // Reply arrives after release.
    fake.resolvePeel({ cardId: 'card-1', pos: [0, 0.5, 0], rot: [0, 0, 0, 1] });
    await flush();

    // The closure detected the cancel and released the peeled card.
    expect(card.released).toEqual([{}]);
    expect(tool.hasActiveGesture()).toBe(false);
  });

  test('reply arrives before release; subsequent release triggers a direct card release', async () => {
    const deck = new FakeHandle('deck-1', 'deck', [0, 0.5, 0]);
    const card = new FakeHandle('card-1', 'card', [0, 0.5, 0]);
    scene.add(deck.obj);
    const { world, fake } = makeWorld([deck, card]);
    fake.setDeferred(true);
    const ctx = makeCtx(world, camera, scene, canvas);
    tool.onActivate(ctx);

    const t0 = performance.now();
    tool.onPress(pointerEvent({ timestamp: t0 }), ctx);
    tool.onMove(pointerEvent({ timestamp: t0 + 20, clientX: 100, clientY: 100, worldX: 1 }), ctx);
    fake.resolvePeel({ cardId: 'card-1', pos: [0, 0.5, 0], rot: [0, 0, 0, 1] });
    await flush();

    // Still in PendingPeel because heldBy hasn't flipped yet.
    expect(card.released).toEqual([]);

    // User releases — onRelease must release the peeled card immediately.
    tool.onRelease(pointerEvent({ timestamp: t0 + 30, clientX: 100, clientY: 100 }), ctx);
    expect(card.released).toEqual([{}]);
    expect(tool.hasActiveGesture()).toBe(false);
  });

  test('cancel via onDeactivate during PendingPeel — closure releases card on reply', async () => {
    const deck = new FakeHandle('deck-1', 'deck', [0, 0.5, 0]);
    const card = new FakeHandle('card-1', 'card', [0, 0.5, 0]);
    scene.add(deck.obj);
    const { world, fake } = makeWorld([deck, card]);
    fake.setDeferred(true);
    const ctx = makeCtx(world, camera, scene, canvas);
    tool.onActivate(ctx);

    const t0 = performance.now();
    tool.onPress(pointerEvent({ timestamp: t0 }), ctx);
    tool.onMove(pointerEvent({ timestamp: t0 + 20, clientX: 100, clientY: 100, worldX: 1 }), ctx);
    tool.onDeactivate(ctx);

    fake.resolvePeel({ cardId: 'card-1', pos: [0, 0.5, 0], rot: [0, 0, 0, 1] });
    await flush();

    expect(card.released).toEqual([{}]);
  });
});

// selectionLayoutHotkey — keyboard glue for the grid-layout feature.
//
// Resolver: parses a bare-digit `1..9` keydown into a column count, or null
// when the event should be ignored. Suppression mirrors the toolbar hotkey
// (text-input focus, key-repeat) and adds an active-gesture check so layout
// does not fight a mid-drag / mid-marquee / mid-rotate / mid-flick-aim.
//
// Performer: orchestrates the actual layout — history snapshot, multi-claim,
// resolveSelectionLayout call, per-entity transform write + velocity zero,
// release. Kept separate from the resolver so wiring code only has to read
// the input event in one place.

import { type World, type EntityHandle } from '../entity/world';
import { type SeatIndex } from '../seats/SeatLayout';
import { type SceneHistoryService } from '../entity/SceneHistoryService';
import { MeshComponent } from '../entity/components/MeshComponent';
import { PhysicsComponent } from '../entity/components/PhysicsComponent';
import { TransformComponent } from '../entity/components/TransformComponent';
import {
  resolveSelectionLayout,
  type CameraAxes,
  type LayoutPlan,
} from './selectionLayout';

interface KeyEventLike {
  key:       string;
  repeat:    boolean;
  ctrlKey?:  boolean;
  metaKey?:  boolean;
  altKey?:   boolean;
  shiftKey?: boolean;
}

// Returns the requested column count (1..9), or null if the event should be
// ignored. Suppression mirrors PRD: text-input focus, key-repeat, active
// tool gesture, any modifier (modifier-digit is reserved for the toolbar).
export function resolveLayoutHotkey(
  e: KeyEventLike,
  flags: {
    textInputFocused: boolean;
    activeGesture:    boolean;
  },
): number | null {
  if (e.repeat) return null;
  if (flags.textInputFocused) return null;
  if (flags.activeGesture) return null;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  if (e.key.length !== 1) return null;
  const n = parseInt(e.key, 10);
  if (!Number.isFinite(n) || n < 1 || n > 9) return null;
  return n;
}

export interface PerformLayoutDeps {
  world:      World;
  selection:  ReadonlySet<string>;
  cameraAxes: CameraAxes;
  selfSeat:   SeatIndex | null;
  history:    SceneHistoryService | null;
  columns:    number;
}

// Run the layout end-to-end. Returns the number of entities that were
// actually moved (0 when the action no-ops).
export function performSelectionLayout(deps: PerformLayoutDeps): number {
  const { world, selection, cameraAxes, selfSeat, history, columns } = deps;
  if (selection.size < 2 || selfSeat === null) return 0;

  const ids = Array.from(selection);

  // Multi-claim before computing the plan. Entities already held by self
  // (mid-drag layout) pass straight through; those held by other peers are
  // skipped; the rest go through tryHold. Only the freshly-claimed ones are
  // released at the end so we don't tear down an in-flight drag.
  const inScope:    EntityHandle[] = [];
  const freshClaim: EntityHandle[] = [];
  for (const id of ids) {
    const h = world.get(id);
    if (!h) continue;
    const heldBy = h.heldBy();
    if (heldBy === selfSeat) {
      inScope.push(h);
    } else if (heldBy === null) {
      if (h.tryHold(selfSeat)) {
        inScope.push(h);
        freshClaim.push(h);
      }
    }
  }
  if (inScope.length < 2) {
    for (const h of freshClaim) h.release();
    return 0;
  }

  // Snapshot once before any writes — single Ctrl+Z reverts the whole layout.
  if (history) history.push(`Arrange grid ${columns}`);

  const plans = resolveSelectionLayout({
    selection: inScope.map(h => h.id),
    getTransform: (id) => {
      const t = world.get(id)?.get(TransformComponent);
      if (!t) return null;
      const obj = t.object3d;
      const p = obj?.position ?? { x: t.state.position[0], y: t.state.position[1], z: t.state.position[2] };
      const q = obj?.quaternion ?? { x: t.state.rotation[0], y: t.state.rotation[1], z: t.state.rotation[2], w: t.state.rotation[3] };
      return {
        position: [p.x, p.y, p.z],
        rotation: [q.x, q.y, q.z, q.w],
      };
    },
    getExtent: (id) => world.get(id)?.get(MeshComponent)?.halfExtents() ?? null,
    getCapability: (id) => {
      const h = world.get(id);
      if (!h) return { claimable: false, movable: false, extentKnown: false };
      const phys = h.get(PhysicsComponent);
      return {
        claimable:   true,
        movable:     phys ? !phys.state.isLocked : true,
        extentKnown: !!h.get(MeshComponent),
      };
    },
    camera:  cameraAxes,
    columns,
  });

  for (const plan of plans) {
    const h = world.get(plan.entityId);
    if (!h) continue;
    writePlan(h, plan);
  }

  for (const h of freshClaim) h.release();
  return plans.length;
}

function writePlan(handle: EntityHandle, plan: LayoutPlan): void {
  const t = handle.get(TransformComponent);
  if (!t) return;
  t.setState({
    position: [plan.position[0], plan.position[1], plan.position[2]],
    rotation: [plan.rotation[0], plan.rotation[1], plan.rotation[2], plan.rotation[3]],
    scale:    t.state.scale,
  });
  const phys = handle.get(PhysicsComponent);
  if (phys?.body) {
    phys.body.position.set(plan.position[0], plan.position[1], plan.position[2]);
    phys.body.quaternion.set(plan.rotation[0], plan.rotation[1], plan.rotation[2], plan.rotation[3]);
    phys.body.velocity.setZero();
    phys.body.angularVelocity.setZero();
  }
}

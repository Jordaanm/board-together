// Host-only operations on Bags. Issue #3 of issues--bag.md.
//
// `pickRandom(bagId, seat)` is the host-side counterpart to the player's
// short-press-drag gesture: un-contain a uniform-random item, claim a hold
// for the requesting seat, and reply with the new pose. Mirrors
// DeckService.peelTop's shape so World.peelAndHold can route both verbs
// through the same wire format.

import { type SceneImpl } from './Scene';
import { type Entity } from './Entity';
import { type SeatIndex } from '../seats/SeatLayout';
import { type HostReplicatorV2 } from './HostReplicatorV2';
import { type PeelAndHoldResult } from './wire';
import { BagComponent } from './components/BagComponent';
import { TransformComponent } from './components/TransformComponent';
import { PhysicsComponent } from './components/PhysicsComponent';
import { MeshComponent } from './components/MeshComponent';

export interface BagHostFacade {
  // Synchronous hold-claim for the freshly-picked entity. Delegates to the
  // host's HoldService.tryClaim. Returns true on success.
  tryHold:     (entity: Entity, seat: SeatIndex) => boolean;
  // Defensive cleanup if tryHold somehow fails after the picked entity has
  // been un-contained (shouldn't happen in practice).
  releaseHold: (entity: Entity) => void;
}

// Tiny gap above the bag mesh so the un-contained body doesn't overlap the
// bag's collider when re-entering the world.
const LIFT_GAP = 0.005;

export class BagService {
  constructor(
    private readonly scene:      SceneImpl,
    private readonly replicator: HostReplicatorV2,
    private readonly host:       BagHostFacade,
    // Injected so tests can seed determinism. Production passes Math.random.
    private readonly rng: () => number = Math.random,
  ) {}

  // Atomic pop-random + hold. Returns the picked entity's id and pose, or
  // null when the bag is unknown / has no BagComponent / is empty, or the
  // hold defensively fails. Caller is responsible for `canManipulate` gating.
  pickRandom(bagId: string, callerSeat: SeatIndex): PeelAndHoldResult | null {
    const bag = this.scene.getEntity(bagId);
    if (!bag) return null;
    const bagC = bag.getComponent(BagComponent);
    if (!bagC) return null;
    if (bagC.state.contents.length === 0) return null;

    const idx = Math.floor(this.rng() * bagC.state.contents.length);
    const pickedId = bagC.state.contents[idx];
    const picked = this.scene.getEntity(pickedId);
    if (!picked) return null;

    // Surface the picked entity just above the bag in world +Y. The bag's
    // own mesh is yaw-only, so a world-axis lift is sufficient; we don't
    // need the deck's local-+Y rotation gymnastics.
    const bagTransform = bag.getComponent(TransformComponent);
    if (!bagTransform) return null;
    const bagMesh    = bag.getComponent(MeshComponent);
    const pickedMesh = picked.getComponent(MeshComponent);
    const bagHalfH    = (bagMesh?.state.height ?? 0)    * 0.5;
    const pickedHalfH = (pickedMesh?.state.height ?? 0) * 0.5;
    const lift = bagHalfH + pickedHalfH + LIFT_GAP;
    const pos: [number, number, number] = [
      bagTransform.state.position[0],
      bagTransform.state.position[1] + lift,
      bagTransform.state.position[2],
    ];
    const pickedTransform = picked.getComponent(TransformComponent);
    const rot: [number, number, number, number] = pickedTransform
      ? [
          pickedTransform.state.rotation[0],
          pickedTransform.state.rotation[1],
          pickedTransform.state.rotation[2],
          pickedTransform.state.rotation[3],
        ]
      : [0, 0, 0, 1];

    // Remove from contents first so a concurrent guest call can't see the
    // same index. Single-threaded JS makes this genuinely atomic.
    const nextContents = bagC.state.contents.slice();
    nextContents.splice(idx, 1);
    bagC.setState({ contents: nextContents });
    this.releaseFromBag(picked, bag, pos, rot);

    if (!this.host.tryHold(picked, callerSeat)) {
      this.host.releaseHold(picked);
      return null;
    }
    return { cardId: pickedId, pos, rot };
  }

  // Shared between pickRandom and (future) script remove: clear isContained
  // / parentId, snap transform + body to the supplied pose. Mirrors
  // DeckService.releaseCardFromDeck. Public so BagFacade in slice #4 can
  // reuse it from script-driven extracts.
  releaseFromBag(
    entity: Entity,
    bag:    Entity,
    pos:    readonly [number, number, number],
    rot:    readonly [number, number, number, number],
  ): void {
    if (entity.isContained) {
      entity.isContained = false;
      for (const comp of entity.components.values()) comp.onIsContainedChanged(false);
      this.replicator.enqueueEntityPatch(entity.id, { isContained: false });
    }
    if (entity.parentId !== null) {
      const parent = this.scene.getEntity(entity.parentId);
      if (parent && parent === bag) {
        parent.children = parent.children.filter((c) => c !== entity.id);
        this.replicator.enqueueEntityPatch(parent.id, { children: [...parent.children] });
      }
      entity.parentId = null;
      this.replicator.enqueueEntityPatch(entity.id, { parentId: null });
    }
    const transform = entity.getComponent(TransformComponent);
    if (transform) {
      transform.setState({
        position: [pos[0], pos[1], pos[2]],
        rotation: [rot[0], rot[1], rot[2], rot[3]],
        scale:    transform.state.scale,
      });
    }
    const phys = entity.getComponent(PhysicsComponent);
    if (phys?.body) {
      phys.body.position.set(pos[0], pos[1], pos[2]);
      phys.body.quaternion.set(rot[0], rot[1], rot[2], rot[3]);
      phys.body.velocity.setZero();
      phys.body.angularVelocity.setZero();
    }
  }
}

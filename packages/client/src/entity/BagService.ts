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
import { DeckComponent } from './components/DeckComponent';
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
    const extracted = this.extractRandom(bagId);
    if (!extracted) return null;
    if (!this.host.tryHold(extracted.entity, callerSeat)) {
      this.host.releaseHold(extracted.entity);
      return null;
    }
    return { cardId: extracted.entity.id, pos: extracted.pos, rot: extracted.rot };
  }

  // Script entry: extract a uniform-random item but do NOT claim a hold for
  // any seat. Returns the picked entity id, or null on empty / missing bag.
  // Mirrors `pickRandom` minus the hold-claim step (scripts have no cursor).
  pickRandomNoHold(bagId: string): string | null {
    const extracted = this.extractRandom(bagId);
    return extracted ? extracted.entity.id : null;
  }

  // Script entry: extract a specific item from a bag. Returns true on success,
  // false when the bag is unknown / has no BagComponent / the entity isn't a
  // member.
  removeFromBag(bagId: string, entityId: string): boolean {
    const bag = this.scene.getEntity(bagId);
    if (!bag) return false;
    const bagC = bag.getComponent(BagComponent);
    if (!bagC) return false;
    const idx = bagC.state.contents.indexOf(entityId);
    if (idx < 0) return false;
    const entity = this.scene.getEntity(entityId);
    if (!entity) return false;
    const { pos, rot } = this.extractPoseFor(bag, entity);
    const nextContents = bagC.state.contents.slice();
    nextContents.splice(idx, 1);
    bagC.setState({ contents: nextContents });
    this.releaseFromBag(entity, bag, pos, rot);
    return true;
  }

  // Script entry: move an entity into a bag. Detaches the entity from any
  // prior parent (deck.cards / bag.contents / entity.children) before
  // absorbing. Returns false when the bag refuses (canAccept false), when
  // the entity is already in the bag, or on missing inputs.
  addToBag(bagId: string, entityId: string): boolean {
    const bag = this.scene.getEntity(bagId);
    if (!bag) return false;
    const bagC = bag.getComponent(BagComponent);
    if (!bagC) return false;
    const entity = this.scene.getEntity(entityId);
    if (!entity) return false;
    if (entity === bag) return false;
    if (bagC.state.contents.includes(entityId)) return false;
    if (!bagC.canAccept(entity)) return false;

    // Detach from any prior parent: update the parent's `children`, plus
    // its specialized container slot (deck.cards / bag.contents) if present.
    if (entity.parentId !== null) {
      const prevParent = this.scene.getEntity(entity.parentId);
      if (prevParent) {
        prevParent.children = prevParent.children.filter((c) => c !== entityId);
        this.replicator.enqueueEntityPatch(prevParent.id, { children: [...prevParent.children] });
        const prevDeck = prevParent.getComponent(DeckComponent);
        if (prevDeck && prevDeck.state.cards.includes(entityId)) {
          prevDeck.setState({ cards: prevDeck.state.cards.filter((c) => c !== entityId) });
        }
        const prevBag = prevParent.getComponent(BagComponent);
        if (prevBag && prevBag.state.contents.includes(entityId)) {
          prevBag.setState({ contents: prevBag.state.contents.filter((c) => c !== entityId) });
        }
      }
    }

    // Attach to the new bag.
    const nextChildren = [...bag.children, entityId];
    bag.children = nextChildren;
    this.replicator.enqueueEntityPatch(bag.id, { children: [...nextChildren] });
    bagC.setState({ contents: [...bagC.state.contents, entityId] });
    entity.parentId = bagId;
    this.replicator.enqueueEntityPatch(entityId, { parentId: bagId });
    if (!entity.isContained) {
      entity.isContained = true;
      for (const comp of entity.components.values()) comp.onIsContainedChanged(true);
      this.replicator.enqueueEntityPatch(entityId, { isContained: true });
    }
    return true;
  }

  // Shared pick path: pop a uniform-random index, un-contain the entity at
  // the bag's pose-derived lift, return the entity + pose. Does NOT claim a
  // hold — callers layer that on if needed.
  private extractRandom(bagId: string): { entity: Entity; pos: [number, number, number]; rot: [number, number, number, number] } | null {
    const bag = this.scene.getEntity(bagId);
    if (!bag) return null;
    const bagC = bag.getComponent(BagComponent);
    if (!bagC) return null;
    if (bagC.state.contents.length === 0) return null;

    const idx = Math.floor(this.rng() * bagC.state.contents.length);
    const pickedId = bagC.state.contents[idx];
    const picked = this.scene.getEntity(pickedId);
    if (!picked) return null;

    const { pos, rot } = this.extractPoseFor(bag, picked);
    const nextContents = bagC.state.contents.slice();
    nextContents.splice(idx, 1);
    bagC.setState({ contents: nextContents });
    this.releaseFromBag(picked, bag, pos, rot);
    return { entity: picked, pos, rot };
  }

  // Returns the pose an extracted entity should be placed at: bag's center
  // lifted along world +Y so the body doesn't overlap the bag's collider
  // when re-entering the physics world.
  private extractPoseFor(bag: Entity, picked: Entity): {
    pos: [number, number, number];
    rot: [number, number, number, number];
  } {
    const bagTransform = bag.getComponent(TransformComponent);
    const bagMesh      = bag.getComponent(MeshComponent);
    const pickedMesh   = picked.getComponent(MeshComponent);
    const bagPos       = bagTransform?.state.position ?? [0, 0, 0];
    const bagHalfH     = (bagMesh?.state.height ?? 0)    * 0.5;
    const pickedHalfH  = (pickedMesh?.state.height ?? 0) * 0.5;
    const lift         = bagHalfH + pickedHalfH + LIFT_GAP;
    const pos: [number, number, number] = [
      bagPos[0], bagPos[1] + lift, bagPos[2],
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
    return { pos, rot };
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

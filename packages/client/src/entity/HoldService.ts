// Host-side hold lifecycle for entity drag.
// Slice #5 of planning/issues/issues--scene-graph.md.
//
// `entity.heldBy` is the per-seat lock. The host is the sole authority — it
// validates claims, sets / clears `heldBy`, toggles the physics body to
// kinematic during a hold, and broadcasts hold-claim / hold-release messages
// to all peers (including the claimer, so guests confirm acceptance).
//
// Host's own drags + inbound guest hold-claim messages both flow through
// `tryClaim` / `release`, so the policy lives in one place.

import * as CANNON from 'cannon-es';
import { type SceneImpl } from './Scene';
import { type Entity } from './Entity';
import { type SeatIndex } from '../seats/SeatLayout';
import { type HostReplicatorV2 } from './HostReplicatorV2';
import { type MergeService } from './MergeService';
import { PhysicsComponent } from './components/PhysicsComponent';
import { TransformComponent } from './components/TransformComponent';
import { ZoneComponent } from './components/ZoneComponent';
import { resolveSnap } from './snap/resolveSnap';
import { gatherSnapCandidates, collectDescendantIds, yawToQuat } from './snap/snapHost';

export interface ReleaseVelocity {
  vx: number;
  vy: number;
  vz: number;
}

export class HoldService {
  // Cache the body's pre-claim type so we restore it (DYNAMIC/STATIC) on release.
  private priorBodyType = new Map<string, CANNON.BodyType>();
  // Cache the body's pre-claim collisionResponse. Held bodies become sensors
  // (collisionResponse=false) so dragging never pushes other entities; the
  // prior value is restored on release. Issue #1 of issues--drag-refactor.md.
  private priorCollisionResponse = new Map<string, boolean>();
  private mergeService: MergeService | null = null;

  constructor(
    private readonly replicator: HostReplicatorV2,
    private readonly scene:      SceneImpl,
  ) {}

  // Optional injection — World wires this on host construction. HoldService
  // tests can omit it; the recheck path is a no-op when null.
  setMergeService(merge: MergeService): void {
    this.mergeService = merge;
  }

  // First-claimer-wins. Returns false if the entity is already held or its
  // PhysicsComponent is locked — the host drops the claim silently and the
  // guest's optimistic drag UI times out / unwinds locally.
  tryClaim(entity: Entity, seat: SeatIndex): boolean {
    if (entity.heldBy !== null) return false;
    const phys = entity.getComponent(PhysicsComponent);
    if (phys?.state.isLocked) return false;
    entity.cancelTween();
    entity.heldBy = seat;

    const body = entity.getComponent(PhysicsComponent)?.body;
    if (body) {
      this.priorBodyType.set(entity.id, body.type);
      this.priorCollisionResponse.set(entity.id, body.collisionResponse);
      body.type = CANNON.Body.KINEMATIC;
      body.collisionResponse = false;
      body.velocity.setZero();
      body.angularVelocity.setZero();
      body.wakeUp();
    }

    this.replicator.enqueueHoldClaim({ entityId: entity.id, seat });
    return true;
  }

  release(entity: Entity, vel?: ReleaseVelocity): void {
    if (entity.heldBy === null) return;
    entity.heldBy = null;

    const snap = this.resolveSnapForRelease(entity);
    const body = entity.getComponent(PhysicsComponent)?.body;
    if (body) {
      const prior = this.priorBodyType.get(entity.id) ?? CANNON.Body.DYNAMIC;
      body.type = prior;
      this.priorBodyType.delete(entity.id);
      const priorResponse = this.priorCollisionResponse.get(entity.id);
      body.collisionResponse = priorResponse ?? true;
      this.priorCollisionResponse.delete(entity.id);
      if (snap) {
        // Snap hit: zero velocity and skip the throw entirely. Position is
        // applied below via the TransformComponent setState so guests see the
        // teleport on the reliable channel.
        body.velocity.setZero();
      } else if (vel) {
        body.velocity.set(vel.vx, vel.vy, vel.vz);
      } else {
        body.velocity.setZero();
      }
      body.angularVelocity.setZero();
      body.wakeUp();
    }

    if (snap) this.applySnap(entity, snap);

    this.replicator.enqueueHoldRelease(
      vel
        ? { entityId: entity.id, vx: vel.vx, vy: vel.vy, vz: vel.vz }
        : { entityId: entity.id },
    );

    // Held-state filter excludes carried entities from zone membership; on
    // release any zone whose AABB still overlaps the body must include it.
    for (const z of this.scene.all()) {
      const zone = z.getComponent(ZoneComponent);
      if (zone) zone.recomputeMembership();
    }

    // Merge recheck — issue #4 of issues--deck.md. A card released onto a deck
    // that was already in physical contact never re-fires beginContact, so we
    // poll the live contact set here.
    this.mergeService?.recheckMergeOverlaps(entity);
  }

  // Peer disconnect: drop every hold owned by the leaving seat. No final
  // velocity — the body is dropped where it sits.
  releaseAllForSeat(seat: SeatIndex): void {
    for (const entity of this.scene.all()) {
      if (entity.heldBy === seat) this.release(entity);
    }
  }

  // Drop every internal hold-tracking state without firing release messages.
  // Used by World.replaceScene: the entire scene is wiped and the
  // scene-replace envelope is the authoritative reset, so per-entity
  // hold-release wire chatter would be redundant.
  clearAllHoldState(): void {
    this.priorBodyType.clear();
    this.priorCollisionResponse.clear();
  }

  // Zone-entry suppression placeholder (PRD-2 reads this when wiring zones).
  // An entity with `heldBy != null` is being carried; zones should ignore
  // overlap events for it until released.
  static suppressZoneEvents(entity: Entity): boolean {
    return entity.heldBy !== null;
  }

  // ── Snap on release (issue #3 of issues--snap.md) ─────────────────────
  // Pure read against the scene + the dropped entity's transform. Returns
  // null when no candidate point is within radius.
  private resolveSnapForRelease(entity: Entity) {
    const t = entity.getComponent(TransformComponent);
    if (!t) return null;
    const [dx, _dy, dz] = t.state.position;
    return resolveSnap({
      droppedXZ:       [dx, dz],
      droppedEntityId: entity.id,
      descendantIds:   collectDescendantIds(this.scene, entity.id),
      candidates:      gatherSnapCandidates(this.scene),
    });
  }

  private applySnap(
    entity: Entity,
    snap: { targetPos: [number, number, number]; targetYaw: number; snapRotation: boolean; snapY: boolean },
  ): void {
    const t = entity.getComponent(TransformComponent);
    if (!t) return;
    const nextRotation = snap.snapRotation
      ? yawToQuat(snap.targetYaw)
      : t.state.rotation;
    // snapY off (default) leaves the entity's existing Y intact so taller
    // bodies don't get pulled through the table when snapping in XZ.
    const nextY = snap.snapY ? snap.targetPos[1] : t.state.position[1];
    const nextPos: [number, number, number] = [snap.targetPos[0], nextY, snap.targetPos[2]];
    t.setState({
      position: nextPos,
      rotation: nextRotation,
      scale:    t.state.scale,
    });
    // Sync the physics body so the next physics tick doesn't immediately
    // overwrite the snap with the body's stale pose.
    const body = entity.getComponent(PhysicsComponent)?.body;
    if (body) {
      body.position.set(nextPos[0], nextPos[1], nextPos[2]);
      const [qx, qy, qz, qw] = nextRotation;
      body.quaternion.set(qx, qy, qz, qw);
    }
  }
}

// World — issues #1 and #2 of issues--arch.md.
//
// Composes Scene + HostReplicatorV2 + HoldService + HostInputDispatcher +
// GuestInputHandler behind a single facade so ThreeCanvas can collapse five
// modules' worth of wiring into one createWorld call. Each World owns its own
// SceneImpl by default; ThreeCanvas opts into the legacy global singleton via
// `entityScene` so existing DragController / findEntityByObject3D consumers
// continue to see the same entities.
//
// Components hold a per-instance `world` reference (issue #6) injected by
// SceneImpl.add when they join a scene with a non-null `world`. World wires
// `scene.world = this.replicator` on host construction; guests leave it null.

import * as THREE from 'three';
import { type Entity } from '../Entity';
import { type SpawnContext } from '../EntityComponent';
import { SceneImpl, entityToSerialized, type EntitySerialized } from '../Scene';
import { HostReplicatorV2 } from '../HostReplicatorV2';
import { componentRegistry } from '../ComponentRegistry';
import { HoldService } from '../HoldService';
import { MergeService } from '../MergeService';
import { DeckService } from '../DeckService';
import { HostInputDispatcher } from '../HostInputDispatcher';
import { SceneHistoryService } from '../SceneHistoryService';
import { GuestInputHandler } from '../../input/GuestInputHandler';
import { type SceneMessage, type EntityFieldsPartial } from '../wire';
import { TransformComponent } from '../components/TransformComponent';
import { PhysicsComponent } from '../components/PhysicsComponent';
import { MeshComponent } from '../components/MeshComponent';
import { SnapPointsComponent } from '../components/SnapPointsComponent';
import { ZoneComponent } from '../components/ZoneComponent';
import { TweenComponent } from '../components/TweenComponent';
import { HandComponent } from '../components/HandComponent';
import { TableComponent } from '../components/TableComponent';
import { CardComponent } from '../components/CardComponent';
import { DeckComponent } from '../components/DeckComponent';
import { registerCorePrimitives } from '../spawnables';
import { getSpawnable } from '../SpawnableRegistry';
import { defaultEntityName } from '../Entity';
import { PhysicsWorld } from '../../physics/PhysicsWorld';
import { TABLE_SURFACE_Y } from '../../scene/Table';
import { TABLE_ENTITY_ID } from '../tableEntity';
import { type TableBounds } from '../Scene';
import { type SeatIndex } from '../../seats/SeatLayout';
import { canManipulate } from '../../seats/OwnershipPolicy';
import { EntityHandleImpl, type HandleRouter } from './EntityHandle';
import { ScriptHost } from '../../scripting/ScriptHost';
import { assetService } from '../../assets/AssetService';
import {
  attachSticker, createSurfaceChild, appendDefaultElement,
  type StickerOpts, type SurfaceChildOpts,
} from '../components/attachSticker';
import { SurfaceComponent } from '../components/SurfaceComponent';
import { type EditorElementKind } from '../components/SurfaceElement';
import {
  type World,
  type WorldOptions,
  type WorldTransport,
  type WorldInboundMessage,
  type WorldIdentity,
  type EntityHandle,
  type SpawnOptions,
  type ReplicationPolicy,
  type GenerateDeckOptions,
} from './types';
import { getPropertySchema, clampForSchema, type PropertyDef } from '../propertySchema';
import { type HoldRelease, type ToolBroadcast, type PlayCardToTable, type ReorderHand, type TweenIntoHand, type PlaySoundMessage, type PeelAndHoldRequest, type PeelAndHoldReply, type PeelAndHoldResult, type OpenSearchRequest, type OpenSearchReply, type CloseSearch, type ReorderDeck } from '../wire';
import { type InputEventName, type InputEventPayload } from '../../input/inputEvents';
import { type GuestInputEvent } from '../../net/SceneState';

// Bounds-enforcement constants — mirror SceneSystemV2 so behaviour is identical
// during the parity slice. Issue #5 deletes the duplicate.
const REST_VEL_THRESHOLD = 0.05;
const REST_Y_MAX         = TABLE_SURFACE_Y + 1.4;
const REST_Y_MIN         = TABLE_SURFACE_Y - 0.05;
const FALL_OFF_Y         = TABLE_SURFACE_Y - 2.0;

interface RestPose {
  px: number; py: number; pz: number;
  qx: number; qy: number; qz: number; qw: number;
}

// Issue #10: defaults preserve current behaviour. channelFor reads each
// component's static `channel` so existing setup keeps routing correctly;
// coalesceFor=merge keeps semantics (Object.assign keys) but collapses
// duplicate intra-tick patches to one envelope; shouldFlush=true means every
// tick flushes both channels.
const DEFAULT_POLICY: ReplicationPolicy = {
  channelFor: (typeId) => {
    const cls = componentRegistry.get(typeId);
    return cls?.channel ?? 'reliable';
  },
  coalesceFor: () => 'merge',
  shouldFlush: () => true,
};

export function createWorld(opts: WorldOptions): World {
  return new WorldImpl(opts);
}

class WorldImpl implements World, HandleRouter {
  private readonly role:       'host' | 'guest';
  private readonly threeScene: THREE.Scene;
  private readonly transport:  WorldTransport;
  private readonly identity:   WorldIdentity;
  private readonly scene:      SceneImpl;
  private readonly physics:    PhysicsWorld | null;
  private readonly replicator: HostReplicatorV2 | null;
  private readonly hold:       HoldService | null;
  private readonly merge:      MergeService | null;
  private readonly decks:      DeckService | null;
  private readonly hostInput:  HostInputDispatcher | null;
  private readonly guestInput: GuestInputHandler | null;
  private readonly history_:   SceneHistoryService | null;
  private readonly scripting_: ScriptHost | null;
  private readonly policy:     ReplicationPolicy;
  private mergeBeginContact:   ((e: { bodyA: import('cannon-es').Body; bodyB: import('cannon-es').Body }) => void) | null = null;
  private mergeEndContact:     ((e: { bodyA: import('cannon-es').Body; bodyB: import('cannon-es').Body }) => void) | null = null;

  private readonly getPeerSeat: (peerId: string) => SeatIndex | null;

  private readonly handles   = new Map<string, EntityHandleImpl>();
  private readonly restPoses = new Map<string, RestPose>();
  private listeners: Array<() => void> = [];
  private toolBroadcastHandlers: Array<(msg: ToolBroadcast) => void> = [];
  private playSoundHandlers:     Array<(msg: PlaySoundMessage) => void> = [];

  private readonly unsubscribeMessage:  () => void;
  private readonly unsubscribePeerJoin: () => void;

  private tickIndex = 0;
  private disposed  = false;

  // Guest-only — pending peelAndHold promises keyed by requestId. The host's
  // peel-and-hold-reply carries the same requestId so the inbound dispatch
  // resolves the matching promise.
  private readonly pendingPeelRequests = new Map<string, (r: PeelAndHoldResult | null) => void>();
  private nextPeelRequestId = 0;

  // Guest-only — same pattern for openInspect.
  private readonly pendingInspectRequests = new Map<string, (r: {
    snapshot: Record<string, { face: string; back: string }> | null;
    lockedBy: SeatIndex | null;
  } | null) => void>();
  private nextInspectRequestId = 0;

  constructor(opts: WorldOptions) {
    registerCorePrimitives();

    this.role       = opts.role;
    this.threeScene = opts.scene;
    this.transport  = opts.transport;
    this.identity   = opts.identity;
    this.scene      = new SceneImpl();
    this.policy     = { ...DEFAULT_POLICY, ...opts.policy };

    this.getPeerSeat = opts.getPeerSeat ?? (() => null);

    if (opts.role === 'host') {
      this.physics    = opts.physics ?? new PhysicsWorld();
      this.replicator = new HostReplicatorV2(this.policy);
      this.scene.world = this.replicator;
      this.hold       = new HoldService(this.replicator, this.scene);
      this.merge      = new MergeService(this.scene, this.replicator, {
        spawnAt: (type, position) => this.spawnEntityAt(type, position),
      });
      this.hold.setMergeService(this.merge);
      this.decks      = new DeckService(this.scene, this.replicator, {
        despawn:     (id) => this.despawn(id),
        tryHold:     (card, seat) => this.hold!.tryClaim(card, seat),
        releaseHold: (card) => this.hold!.release(card),
      });
      this.hostInput  = new HostInputDispatcher(this.hold, this.getPeerSeat, this.scene);
      this.hostInput.setDeckService(this.decks);
      this.guestInput = new GuestInputHandler(this.hold, this.getPeerSeat, this.scene);
      this.guestInput.setDeckService(this.decks);
      this.history_   = new SceneHistoryService(
        {
          replaceScene: (s) => this.replaceScene(s),
          snapshot:     ()  => this.snapshot(),
        },
        { cap: opts.historyCap, captureThumb: opts.captureThumb },
      );
      this.hostInput.setHistoryService(this.history_);
      this.scripting_ = new ScriptHost({
        scene:         this.scene,
        playSound:     (slug) => this.broadcastPlaySound(slug),
        lookupSlug:    (slug) => assetService.lookupSlug(slug),
        listAssets:    (opts) => assetService.listAssets(opts),
        attachSticker: (parentId, opts) => this.attachStickerOnHost(parentId, opts),
      });
      this.installBeginContactHandler();
      // Boot the singleton Table entity. Guests receive it through the
      // standard scene-snapshot replication on join.
      this.spawnEntity('table', { id: TABLE_ENTITY_ID, position: [0, 0, 0] });
    } else {
      this.physics    = null;
      this.replicator = null;
      this.hold       = null;
      this.merge      = null;
      this.decks      = null;
      this.hostInput  = null;
      this.guestInput = null;
      this.history_   = null;
      this.scripting_ = null;
    }

    this.unsubscribeMessage  = this.transport.onMessage((peerId, msg) => this.handleInbound(peerId, msg));
    this.unsubscribePeerJoin = this.transport.onPeerJoin((peerId) => this.handlePeerJoin(peerId));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────
  spawn(type: string, opts: SpawnOptions = {}): EntityHandle {
    if (this.role !== 'host') throw new Error('World.spawn is host-only');
    // Singleton-Table guard. Mirrors the Scene-level check so the history
    // push is skipped on a refused spawn.
    if (type === 'table' && this.scene.getTable() !== undefined) {
      throw new Error('Cannot spawn a second Table: the singleton Table entity already exists');
    }
    this.history_?.push(`spawn ${type}`);
    const entity = this.spawnEntity(type, opts);
    return this.handleFor(entity);
  }

  // Returns the raw Entity. Used by MergeService and the public `spawn()`
  // facade. Always host-only.
  private spawnEntity(type: string, opts: SpawnOptions = {}): Entity {
    const ctx: SpawnContext = { scene: this.threeScene, physics: this.physics, entityScene: this.scene };
    const entity = this.scene.spawn(type, ctx, { id: opts.id });

    const position = opts.position ?? this.defaultSpawnPosition(entity);
    const transform = entity.getComponent(TransformComponent);
    if (transform) {
      transform.setState({
        position,
        rotation: transform.state.rotation,
        scale:    transform.state.scale,
      });
    }
    const phys = entity.getComponent(PhysicsComponent);
    if (phys?.body) {
      phys.body.position.set(position[0], position[1], position[2]);
      phys.body.velocity.setZero();
      phys.body.angularVelocity.setZero();
    }

    if (this.replicator) this.replicator.enqueueEntitySpawn(entityToSerialized(entity));
    this.notify();
    return entity;
  }

  private spawnEntityAt(type: string, position: [number, number, number]): Entity {
    return this.spawnEntity(type, { position });
  }

  // Host-only — attach a fresh SnapPointsComponent (with one default point)
  // to an existing entity and replicate via the `attach-component` wire.
  // Backs the Mesh component's "Add Snap Markers" editor-panel tool.
  // No-op if the entity is unknown or already carries snap-points.
  attachSnapPoints(entityId: string): void {
    if (this.role !== 'host') throw new Error('World.attachSnapPoints is host-only');
    const entity = this.scene.getEntity(entityId);
    if (!entity) return;
    if (entity.hasComponent(SnapPointsComponent)) return;
    this.history_?.push('attach snap points');
    const comp = new SnapPointsComponent();
    comp.fromJSON({ points: [{
      id:           'default',
      localPos:     [0, 0, 0],
      localYaw:     0,
      snapRotation: false,
      snapY:        false,
      radius:       0.4,
    }] });
    entity.attachComponent(comp);
    const ctx: SpawnContext = { scene: this.threeScene, physics: this.physics, entityScene: this.scene };
    comp.onSpawn(ctx);
    if (this.replicator) {
      this.replicator.enqueueAttachComponent({
        entityId,
        typeId: SnapPointsComponent.typeId,
        state:  comp.toJSON(),
      });
    }
    this.notify();
  }

  // Host-only — spawn a child surface entity (prim:plane + SurfaceComponent)
  // on `parentId` and replicate. Powers the Mesh component's "Add Surface"
  // editor-panel tool. Returns the new surface entity's id, or null when the
  // request can't be honoured (unknown parent, parent has no mesh).
  attachSurface(parentId: string, opts: SurfaceChildOpts = {}): string | null {
    if (this.role !== 'host') throw new Error('World.attachSurface is host-only');
    const parent = this.scene.getEntity(parentId);
    if (!parent) return null;
    if (!parent.getComponent(MeshComponent)) return null;
    const ctx: SpawnContext = { scene: this.threeScene, physics: this.physics, entityScene: this.scene };
    try {
      this.history_?.push('attach surface');
      const surface = createSurfaceChild(this.scene, ctx, parent, opts);
      if (this.replicator) this.replicator.enqueueEntitySpawn(entityToSerialized(surface));
      this.notify();
      return surface.id;
    } catch (e) {
      this.scripting_?.errorLog.push('attachSurface', e);
      return null;
    }
  }

  // Host-only — append one element (Rich / Image / Shape) to a surface's
  // `state.elements` array. Backs the Surface component's per-kind editor
  // tool buttons. Returns the new element id, or null on a missing surface
  // / surface without a SurfaceComponent.
  attachElement(surfaceId: string, kind: EditorElementKind): string | null {
    if (this.role !== 'host') throw new Error('World.attachElement is host-only');
    const surface = this.scene.getEntity(surfaceId);
    if (!surface) return null;
    if (!surface.getComponent(SurfaceComponent)) return null;
    try {
      this.history_?.push(`attach ${kind} element`);
      const elementId = appendDefaultElement(surface, kind);
      this.notify();
      return elementId;
    } catch (e) {
      this.scripting_?.errorLog.push('attachElement', e);
      return null;
    }
  }

  // Host-only — patch one element in a surface's elements array. Replicates
  // the whole array via the surface's standard component-patch path.
  // No-op on a missing surface / unknown element id.
  mutateSurfaceElement(surfaceId: string, elementId: string, patch: Record<string, unknown>): void {
    if (this.role !== 'host') throw new Error('World.mutateSurfaceElement is host-only');
    const surface = this.scene.getEntity(surfaceId)?.getComponent(SurfaceComponent);
    if (!surface) return;
    if (!surface.getElement(elementId)) return;
    surface.mutateElement(elementId, patch);
    this.notify();
  }

  // Host-only — drop an element from a surface's elements array. Replicates
  // via the surface's standard component-patch path.
  removeSurfaceElement(surfaceId: string, elementId: string): void {
    if (this.role !== 'host') throw new Error('World.removeSurfaceElement is host-only');
    const surface = this.scene.getEntity(surfaceId)?.getComponent(SurfaceComponent);
    if (!surface) return;
    if (!surface.getElement(elementId)) return;
    this.history_?.push('remove surface element');
    surface.removeElement(elementId);
    this.notify();
  }

  // Backs `scene.attachSticker` (issue #9 of issues--ui-surface.md). Builds
  // the surface entity, appends one element to its state.elements array,
  // enqueues the surface spawn so guests see it, and returns
  // `{ surfaceId, elementId }` so the SceneFacade can wrap the element id
  // in an ElementHandle. Returns null when the request can't be honoured
  // (unknown parent, parent has no mesh).
  private attachStickerOnHost(parentId: string, opts: StickerOpts): { surfaceId: string; elementId: string } | null {
    const parent = this.scene.getEntity(parentId);
    if (!parent) return null;
    if (!parent.getComponent(MeshComponent)) return null;
    const ctx: SpawnContext = { scene: this.threeScene, physics: this.physics, entityScene: this.scene };
    try {
      const { surfaceEntity, elementHandle } = attachSticker(this.scene, ctx, parent, opts);
      if (this.replicator) this.replicator.enqueueEntitySpawn(entityToSerialized(surfaceEntity));
      this.notify();
      return { surfaceId: surfaceEntity.id, elementId: elementHandle.elementId };
    } catch (e) {
      this.scripting_?.errorLog.push('attachSticker', e);
      return null;
    }
  }

  // Mirrors SceneSystemV2.spawn's random table-surface placement so existing
  // EditorPanel-driven spawns land where they used to. Issue #4 reconsiders
  // whether spawn placement is World's concern or the editor's.
  // Subscribes to the cannon world's beginContact event so MergeService runs
  // whenever two PhysicsComponent bodies first touch. Host-only — guests don't
  // run physics. Issue #2 of issues--deck.md.
  private installBeginContactHandler(): void {
    if (!this.physics || !this.merge) return;
    this.mergeBeginContact = (e) => {
      const a = this.findEntityByBody(e.bodyA);
      const b = this.findEntityByBody(e.bodyB);
      if (!a || !b) return;
      this.merge!.noteBeginContact(a, b);
      this.merge!.enqueueContact(a, b);
    };
    this.mergeEndContact = (e) => {
      const a = this.findEntityByBody(e.bodyA);
      const b = this.findEntityByBody(e.bodyB);
      if (!a || !b) return;
      this.merge!.noteEndContact(a, b);
    };
    this.physics.world.addEventListener('beginContact', this.mergeBeginContact);
    this.physics.world.addEventListener('endContact',   this.mergeEndContact);
  }

  private findEntityByBody(body: import('cannon-es').Body): Entity | undefined {
    for (const e of this.scene.all()) {
      const phys = e.getComponent(PhysicsComponent);
      if (phys?.body === body) return e;
    }
    return undefined;
  }

  private defaultSpawnPosition(entity: Entity): [number, number, number] {
    const x = (Math.random() - 0.5) * 6;
    const z = (Math.random() - 0.5) * 3;
    const mesh = entity.getComponent(MeshComponent);
    const hy   = mesh ? mesh.halfExtents()[1] : 0;
    const y    = TABLE_SURFACE_Y + hy + 0.5;
    return [x, y, z];
  }

  despawn(id: string): void {
    if (this.role !== 'host') throw new Error('World.despawn is host-only');
    const target = this.scene.getEntity(id);
    // Singleton-Table guard runs before the history push so a refused
    // despawn doesn't leave a phantom undo entry.
    if (target?.hasComponent(TableComponent)) {
      throw new Error(`Cannot despawn the Table entity (${id}): it is a locked singleton`);
    }
    if (target) this.history_?.push(`despawn ${target.name}`);
    const ctx: SpawnContext = { scene: this.threeScene, physics: this.physics, entityScene: this.scene };
    const removed = this.scene.despawn(id, ctx);
    for (const removedId of removed) {
      this.handles.delete(removedId);
      this.restPoses.delete(removedId);
    }
    if (removed.length > 0 && this.replicator) this.replicator.enqueueDespawn(removed);
    if (removed.length > 0) this.notify();
  }

  // Entity-level field write (issue #1 of property-schema-refactor). Writes
  // `name` / `tags` / `owner` directly on the Entity, replicates via
  // entity-patch, and pushes a history entry. Unknown keys no-op.
  updateEntityField(id: string, key: string, value: unknown): void {
    const entity = this.scene.getEntity(id);
    if (!entity) return;
    this.history_?.push(`update ${entity.name}.${key}`);

    if (key === 'name') {
      entity.name = String(value);
      if (this.replicator) this.replicator.enqueueEntityPatch(entity.id, { name: entity.name });
      this.notify();
      return;
    }
    if (key === 'tags') {
      entity.tags = normaliseTags(value);
      if (this.replicator) this.replicator.enqueueEntityPatch(entity.id, { tags: [...entity.tags] });
      this.notify();
      return;
    }
    if (key === 'owner') {
      const seat = Number(value);
      const owner = Number.isFinite(seat) && seat >= 0 ? (seat as SeatIndex) : null;
      entity.owner = owner;
      if (this.replicator) this.replicator.enqueueEntityPatch(entity.id, { owner });
      this.notify();
      return;
    }
    if (key === 'customData') {
      const next = normaliseCustomData(value);
      entity.customData = new Map(Object.entries(next));
      if (this.replicator) this.replicator.enqueueEntityPatch(entity.id, { customData: { ...next } });
      this.notify();
      return;
    }
  }

  // Component-state field write (issue #1 of property-schema-refactor). Looks
  // up the schema entry on the named component class, pre-clamps via min/max,
  // invokes the adapter `set` if present (else writes `{ [key]: value }`),
  // and calls the component's `setState` so replication and onPropertiesChanged
  // fire on the same path as any other state mutation. No-ops on unknown
  // entity / component / schema entry.
  updateComponentProp(id: string, typeId: string, key: string, value: unknown): void {
    const entity = this.scene.getEntity(id);
    if (!entity) return;
    const comp = entity.components.get(typeId);
    if (!comp) return;
    const cls = componentRegistry.get(typeId);
    if (!cls) return;
    const schema = getPropertySchema(cls);
    const def = schema.find(d => d.key === key) as PropertyDef | undefined;
    if (!def) return;

    this.history_?.push(`update ${entity.name}.${typeId}.${key}`);

    const clamped = clampForSchema(def, value);
    const patch = def.set
      ? def.set(clamped, comp.state as object, entity)
      : ({ [key]: clamped } as Record<string, unknown>);
    comp.setState(patch);
    this.notify();
  }

  // ── Per-frame driver ─────────────────────────────────────────────────────
  tick(dtSeconds: number): void {
    if (this.disposed) return;

    if (this.role === 'host' && this.physics && this.replicator) {
      this.tickTweens(dtSeconds);
      this.syncZoneBodies();
      this.physics.step(dtSeconds);
      const mergeCount = this.merge?.processQueued() ?? 0;
      this.enforceTableBounds();
      this.syncFromPhysics();

      const flushCtx   = { tick: this.tickIndex, nowMs: nowMs() };
      const unreliable = this.replicator.flushUnreliable(flushCtx);
      const reliable   = this.replicator.flushReliable(flushCtx);
      // Reliable first so guests construct entities before unreliable patches
      // arrive — patches for unknown entities are silently dropped, so first-
      // tick transform updates survive the round trip. Per-peer fan-out and
      // privacy scrubbing now live in RtcTransport (issue #7).
      for (const msg of reliable)   this.transport.send(msg, { reliable: true  });
      for (const msg of unreliable) this.transport.send(msg, { reliable: false });

      // Merges mutate parentId / children / isContained without going through
      // any path that already calls notify(), so subscribers (e.g. EditorPanel)
      // never see the new hierarchy until the next unrelated change. Refresh
      // here so the scene-graph view reflects card→deck reparenting in real time.
      if (mergeCount > 0) this.notify();
    }

    this.tickIndex++;
  }

  private enforceTableBounds(): void {
    const { halfWidth, halfDepth } = this.scene.getTableBounds();
    for (const entity of this.scene.all()) {
      // Skip the Table itself — it's locked at origin and doesn't need
      // rest-pose tracking or fall-off recovery.
      if (entity.id === TABLE_ENTITY_ID) continue;
      const phys = entity.getComponent(PhysicsComponent);
      if (!phys?.body) continue;
      const body = phys.body;
      const px = body.position.x, py = body.position.y, pz = body.position.z;

      const onTable = py >= REST_Y_MIN && py <= REST_Y_MAX
                   && Math.abs(px) <= halfWidth
                   && Math.abs(pz) <= halfDepth;
      const settled = body.velocity.length() + body.angularVelocity.length() < REST_VEL_THRESHOLD;
      if (onTable && settled) {
        this.restPoses.set(entity.id, {
          px, py, pz,
          qx: body.quaternion.x, qy: body.quaternion.y,
          qz: body.quaternion.z, qw: body.quaternion.w,
        });
      }

      const restPose = this.restPoses.get(entity.id);
      if (py < FALL_OFF_Y && restPose) {
        body.position.set(restPose.px, restPose.py, restPose.pz);
        body.quaternion.set(restPose.qx, restPose.qy, restPose.qz, restPose.qw);
        body.velocity.setZero();
        body.angularVelocity.setZero();
        body.wakeUp();
      }
    }
  }

  private syncFromPhysics(): void {
    for (const entity of this.scene.all()) {
      entity.getComponent(PhysicsComponent)?.syncToTransform();
    }
  }

  // Push each zone's TransformComponent pose into its sensor body before the
  // physics step so contact events fire against the correct world-space AABB.
  private syncZoneBodies(): void {
    for (const entity of this.scene.all()) {
      entity.getComponent(ZoneComponent)?.syncBodyFromTransform();
    }
  }

  // Advance every active tween by dt before physics integrates. Tweens write
  // interpolated pose into both TransformComponent and the physics body so
  // sensor AABBs (zones) track the motion.
  private tickTweens(dtSeconds: number): void {
    for (const entity of this.scene.all()) {
      entity.getComponent(TweenComponent)?.tick(dtSeconds);
    }
  }

  // ── Read surface ─────────────────────────────────────────────────────────
  get(id: string): EntityHandle | undefined {
    const entity = this.scene.getEntity(id);
    return entity ? this.handleFor(entity) : undefined;
  }

  all(): EntityHandle[] {
    return this.scene.all().map(e => this.handleFor(e));
  }

  pickByObject3D(obj: THREE.Object3D): EntityHandle | undefined {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      for (const entity of this.scene.all()) {
        const t = entity.getComponent(TransformComponent);
        if (t?.object3d !== cur) continue;
        // Contained entities (cards inside a deck) are invisible and have no
        // physics body, but their THREE.Object3D still exists. THREE's
        // raycaster doesn't auto-skip invisible meshes, so guard here.
        if (entity.isContained) return undefined;
        return this.handleFor(entity);
      }
      cur = cur.parent;
    }
    return undefined;
  }

  forEach(fn: (h: EntityHandle) => void): void {
    for (const entity of this.scene.all()) fn(this.handleFor(entity));
  }

  getTable(): EntityHandle | undefined {
    const entity = this.scene.getTable();
    return entity ? this.handleFor(entity) : undefined;
  }

  getTableBounds(): TableBounds {
    return this.scene.getTableBounds();
  }

  // ── Subscriptions ────────────────────────────────────────────────────────
  // Coalesced — fires once per state-affecting operation (spawn, despawn,
  // updateEntityField, updateComponentProp, inbound message). Per-tick
  // coalescing tightens further in issue #4 when EditorPanel becomes the
  // primary consumer.
  subscribe(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }

  // Public refresh hook. Component-driven action dispatchers (editor panel
  // tool actions, context-menu fallbacks) call setState directly and then
  // need a way to ask the panel to re-aggregate — they go through here.
  requestRefresh(): void {
    this.notify();
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  // ── Snapshot / load ──────────────────────────────────────────────────────
  snapshot(): EntitySerialized[] {
    // Snap any active tweens to their target pose so the snapshot captures
    // the destination — tween internals are transient and would otherwise be
    // lost across a save / load round-trip.
    for (const entity of this.scene.all()) {
      const tween = entity.getComponent(TweenComponent);
      if (tween?.isActive()) tween.snapToTarget();
    }
    return this.scene.all().map(entityToSerialized);
  }

  loadSnapshot(snaps: readonly EntitySerialized[]): void {
    const ctx: SpawnContext = { scene: this.threeScene, physics: this.physics, entityScene: this.scene };
    this.scene.load(snaps, ctx);
    this.notify();
  }

  get history(): SceneHistoryService | null {
    return this.history_;
  }

  get scripting(): ScriptHost | null {
    return this.scripting_;
  }

  // Atomic scene replace (PRD § Save / Load). Cancels all holds, cascade-
  // despawns every entity through the existing despawn path (component
  // onDespawn fires; THREE/cannon resources tear down; in-flight tweens
  // cancel via TweenComponent.onDespawn), then runs scene.load(snaps) via
  // the two-pass construction. Host clears replicator pending state and
  // emits a single `scene-replace` envelope so guests apply the same reset
  // atomically. UI state (camera, selection, current tool) is not touched.
  replaceScene(snaps: readonly EntitySerialized[]): void {
    if (this.disposed) return;
    // Re-bootstrap the Table from the spawnable's defaults when loading a
    // pre-Table-as-entity legacy save. The synthesised entry is prepended
    // so the host and every guest see an identical effective snapshot.
    const effective = this.role === 'host' ? ensureTableInSnaps(snaps) : snaps;
    this.applyReplace(effective);
    if (this.role === 'host') {
      this.replicator?.clearPending();
      this.transport.send(
        { type: 'scene-replace', entities: [...effective] },
        { reliable: true },
      );
    }
  }

  private applyReplace(snaps: readonly EntitySerialized[]): void {
    const ctx: SpawnContext = { scene: this.threeScene, physics: this.physics, entityScene: this.scene };

    for (const entity of this.scene.all()) {
      entity.heldBy = null;
    }
    this.hold?.clearAllHoldState();

    // Cascade-despawn from top-level roots so contained children fire
    // onDespawn through their parent's traversal. cascadeDespawn no-ops on
    // already-removed ids, so repeating for any orphans is safe.
    const topLevelIds = this.scene.all()
      .filter(e => e.parentId === null)
      .map(e => e.id);
    // `force: true` bypasses the Table singleton-despawn gate — replaceScene
    // is an atomic internal lifecycle operation, not a user-initiated delete.
    for (const id of topLevelIds) {
      const removed = this.scene.despawn(id, ctx, { force: true });
      for (const r of removed) {
        this.handles.delete(r);
        this.restPoses.delete(r);
      }
    }
    // Defensive sweep for any stragglers.
    for (const entity of [...this.scene.all()]) {
      const removed = this.scene.despawn(entity.id, ctx, { force: true });
      for (const r of removed) {
        this.handles.delete(r);
        this.restPoses.delete(r);
      }
    }

    this.scene.load(snaps, ctx);
    this.notify();
  }

  // ── HandleRouter (issue #3) ─────────────────────────────────────────────
  // Mutation verbs called by EntityHandleImpl. Host writes the body / runs
  // HoldService directly; guest sends RPCs and applies optimistic updates so
  // the local view tracks the cursor without round-tripping the host.
  isHost(): boolean { return this.role === 'host'; }

  selfSeat(): SeatIndex | null {
    return this.identity.selfSeat();
  }

  setPosition(entity: Entity, x: number, y: number, z: number): void {
    const phys = entity.getComponent(PhysicsComponent);
    if (phys?.state.isLocked) return;
    if (this.role === 'host') {
      if (phys?.body) {
        phys.body.position.set(x, y, z);
        return;
      }
      const t = entity.getComponent(TransformComponent);
      if (t) t.setState({ position: [x, y, z], rotation: t.state.rotation, scale: t.state.scale });
      return;
    }
    // Guest: optimistic transform update + guest-drag-move RPC.
    const t = entity.getComponent(TransformComponent);
    if (t) {
      t.applyRemoteState({ position: [x, y, z], rotation: t.state.rotation, scale: t.state.scale });
    }
    this.transport.send(
      { type: 'guest-drag-move', objectId: entity.id, px: x, py: y, pz: z },
      { reliable: false },
    );
  }

  tryHold(entity: Entity, seat: SeatIndex): boolean {
    if (entity.heldBy !== null) return false;
    if (entity.getComponent(PhysicsComponent)?.state.isLocked) return false;
    if (!canManipulate({ peerSeat: seat, isHost: this.role === 'host' }, entity.owner)) return false;

    if (this.role === 'host') {
      return this.hold!.tryClaim(entity, seat);
    }
    // Guest: dispatch RPC; caller polls heldBy() for the host's echo.
    this.transport.send({ type: 'hold-claim', entityId: entity.id, seat }, { reliable: true });
    return true;
  }

  release(entity: Entity, velocity?: { vx: number; vy: number; vz: number }): void {
    if (this.role === 'host') {
      if (entity.heldBy !== null) this.history_?.push(`drop ${entity.name}`);
      this.hold!.release(entity, velocity);
      return;
    }
    const msg: HoldRelease = { type: 'hold-release', entityId: entity.id };
    if (velocity) {
      msg.vx = velocity.vx;
      msg.vy = velocity.vy;
      msg.vz = velocity.vz;
    }
    this.transport.send(msg, { reliable: true });
  }

  // Drag-from-panel-onto-canvas. Host runs the tween directly; guest fires an
  // RPC and lets the host validate + apply (issue #5 of issues--hand.md).
  playCardToTable(entity: Entity, position: [number, number, number]): void {
    if (this.role === 'host') {
      this.history_?.push(`play ${entity.name}`);
      const tween = entity.getComponent(TweenComponent);
      if (tween) tween.tweenTo({ position }, 250);
      return;
    }
    const msg: PlayCardToTable = {
      type:     'play-card-to-table',
      entityId: entity.id,
      x:        position[0],
      y:        position[1],
      z:        position[2],
    };
    this.transport.send(msg, { reliable: true });
  }

  // Drag-within-panel reorder (issue #6 of issues--hand.md). Host calls the
  // hand's reorderContents directly; guest fires the RPC and lets the host
  // validate + apply.
  reorderHand(handEntityId: string, newOrder: readonly string[]): void {
    if (this.role === 'host') {
      const hand = this.scene.getEntity(handEntityId);
      if (hand) this.history_?.push(`reorder ${hand.name}`);
      hand?.getComponent(HandComponent)?.reorderContents(newOrder);
      return;
    }
    const msg: ReorderHand = {
      type:         'reorder-hand',
      handEntityId,
      newOrder:     [...newOrder],
    };
    this.transport.send(msg, { reliable: true });
  }

  // Drag-canvas-onto-panel (issue #7 of issues--hand.md). After GrabTool
  // releases the hold, the entity is tweened to the destination hand's
  // centre so zone-enter triggers HandComponent's slot logic. Host runs the
  // tween directly; guest emits the RPC.
  tweenIntoHand(entity: Entity, handEntityId: string): void {
    if (this.role === 'host') {
      const hand = this.scene.getEntity(handEntityId);
      const handPose = hand?.getComponent(TransformComponent)?.state.position;
      const tween = entity.getComponent(TweenComponent);
      if (!hand || !handPose || !tween) return;
      this.history_?.push(`pick up ${entity.name}`);
      tween.tweenTo({ position: [handPose[0], handPose[1], handPose[2]] }, 250);
      return;
    }
    const msg: TweenIntoHand = { type: 'tween-into-hand', entityId: entity.id, handEntityId };
    this.transport.send(msg, { reliable: true });
  }

  // Right-click Draw on a deck. Host runs the draw directly via DeckService;
  // guest emits the dedicated RPC for the host to validate and apply. Issue
  // #6 of issues--deck.md.
  drawFromDeck(deckId: string, count: number, callerSeat: SeatIndex | null): void {
    if (this.role === 'host') {
      const deck = this.scene.getEntity(deckId);
      if (deck) this.history_?.push(`draw ${count} from ${deck.name}`);
      this.decks?.drawFromDeck(deckId, count, callerSeat);
      return;
    }
    this.transport.send({ type: 'draw-from-deck', deckId, count }, { reliable: true });
  }

  // Right-click Shuffle on a deck. Issue #7 of issues--deck.md.
  shuffleDeck(deckId: string, callerSeat: SeatIndex | null): void {
    if (this.role === 'host') {
      const deck = this.scene.getEntity(deckId);
      if (deck) this.history_?.push(`shuffle ${deck.name}`);
      this.decks?.shuffleDeck(deckId, callerSeat);
      return;
    }
    this.transport.send({ type: 'shuffle-deck', deckId }, { reliable: true });
  }

  // Right-click Deal N on a deck. Issue #9 of issues--deck.md.
  dealFromDeck(deckId: string, count: number, callerSeat: SeatIndex | null): void {
    if (this.role === 'host') {
      const deck = this.scene.getEntity(deckId);
      if (deck) this.history_?.push(`deal ${count} from ${deck.name}`);
      this.decks?.dealFromDeck(deckId, count, callerSeat);
      return;
    }
    this.transport.send({ type: 'deal-from-deck', deckId, count }, { reliable: true });
  }

  // Right-click "Spread deck" — release every card across the table along
  // the deck's local +X axis and despawn the deck.
  spreadDeck(deckId: string, callerSeat: SeatIndex | null): void {
    if (this.role === 'host') {
      const deck = this.scene.getEntity(deckId);
      if (deck) this.history_?.push(`spread ${deck.name}`);
      this.decks?.spreadDeck(deckId, callerSeat);
      return;
    }
    this.transport.send({ type: 'spread-deck', deckId }, { reliable: true });
  }

  // Short-press peel — GrabTool's commit branch for the peel intent. Issue
  // #2 of issues--deck-peel.md. Host: synchronous DeckService.peelTop, wrap
  // the result in a resolved Promise. Guest: dispatch the request RPC,
  // register a one-shot resolver keyed by requestId, resolve when the
  // host's peel-and-hold-reply arrives.
  peelAndHold(deckId: string, seat: SeatIndex): Promise<PeelAndHoldResult | null> {
    if (this.role === 'host') {
      const deck = this.scene.getEntity(deckId);
      if (deck) this.history_?.push(`peel ${deck.name}`);
      const result = this.decks?.peelTop(deckId, seat) ?? null;
      return Promise.resolve(result);
    }
    const requestId = `peel-${this.nextPeelRequestId++}`;
    return new Promise<PeelAndHoldResult | null>((resolve) => {
      this.pendingPeelRequests.set(requestId, resolve);
      const msg: PeelAndHoldRequest = { type: 'peel-and-hold', requestId, deckId };
      this.transport.send(msg, { reliable: true });
    });
  }

  // Open Inspect on a deck. Host runs DeckService.openInspect directly; guest
  // dispatches the RPC and awaits the host's reply. Issue #3 of
  // planning/issues--deck-inspect.md.
  openInspect(deckId: string, seat: SeatIndex): Promise<{
    snapshot: Record<string, { face: string; back: string }> | null;
    lockedBy: SeatIndex | null;
  } | null> {
    if (this.role === 'host') {
      const deck = this.scene.getEntity(deckId);
      if (!deck) return Promise.resolve(null);
      this.history_?.push(`inspect ${deck.name}`);
      const deckC = deck.getComponent(DeckComponent);
      const existing = deckC?.state.searchLockedBy ?? null;
      if (existing !== null && existing !== seat) {
        return Promise.resolve({ snapshot: null, lockedBy: existing });
      }
      const snapshot = this.decks?.openInspect(deckId, seat) ?? null;
      if (!snapshot) return Promise.resolve(null);
      return Promise.resolve({ snapshot, lockedBy: seat });
    }
    const requestId = `inspect-${this.nextInspectRequestId++}`;
    return new Promise((resolve) => {
      // Capture the requesting seat in the resolver so the reply handler can
      // populate lockedBy without a separate side-channel.
      this.pendingInspectRequests.set(requestId, (r) => {
        if (r && r.snapshot && r.lockedBy === null) resolve({ snapshot: r.snapshot, lockedBy: seat });
        else resolve(r);
      });
      const msg: OpenSearchRequest = { type: 'open-search', requestId, deckId };
      this.transport.send(msg, { reliable: true });
    });
  }

  closeInspect(deckId: string, seat: SeatIndex): void {
    if (this.role === 'host') {
      this.decks?.closeInspect(deckId, seat);
      return;
    }
    const msg: CloseSearch = { type: 'close-search', deckId };
    this.transport.send(msg, { reliable: true });
  }

  // Reorder a locked deck from the Inspect dialog. Issue #4 of
  // planning/issues--deck-inspect.md.
  reorderDeck(deckId: string, newOrder: readonly string[], seat: SeatIndex): void {
    if (this.role === 'host') {
      const deck = this.scene.getEntity(deckId);
      const ok = this.decks?.reorderDeck(deckId, newOrder, seat) ?? false;
      if (ok && deck) this.history_?.push(`reorder ${deck.name}`);
      return;
    }
    const msg: ReorderDeck = { type: 'reorder-deck', deckId, newOrder: [...newOrder] };
    this.transport.send(msg, { reliable: true });
  }

  // Spawns one card per face-ref at a single deck position, then wraps them
  // in a fresh Deck entity via MergeService.assembleDeckFrom. Cards are
  // collocated and immediately parented (isContained=true) so they never
  // appear scattered. Backs the host "Generate Deck" tool.
  generateDeck(opts: GenerateDeckOptions): EntityHandle | null {
    if (this.role !== 'host') throw new Error('World.generateDeck is host-only');
    if (!this.merge) return null;
    if (opts.faceRefs.length === 0) return null;

    this.history_?.push('generate deck');

    const position = opts.position ?? this.defaultDeckPosition();

    const cards: Entity[] = [];
    for (const faceRef of opts.faceRefs) {
      const card  = this.spawnEntity('card', { position });
      const cardC = card.getComponent(CardComponent);
      if (cardC) {
        cardC.setState({ face: faceRef, back: opts.backRef, category: opts.category });
      }
      if (opts.tag) {
        card.tags = [...card.tags, opts.tag];
        this.replicator?.enqueueEntityPatch(card.id, { tags: [...card.tags] });
      }
      cards.push(card);
    }

    const deck = this.merge.assembleDeckFrom(cards, position, opts.category);
    if (opts.tag) {
      deck.tags = [...deck.tags, opts.tag];
      this.replicator?.enqueueEntityPatch(deck.id, { tags: [...deck.tags] });
    }

    this.notify();
    return this.handleFor(deck);
  }

  // Picks a scatter position for a freshly-generated deck. Mirrors the
  // X/Z formula in `defaultSpawnPosition` so generated decks land in the
  // same play area as one-off spawns.
  private defaultDeckPosition(): [number, number, number] {
    const x = (Math.random() - 0.5) * 6;
    const z = (Math.random() - 0.5) * 3;
    const y = TABLE_SURFACE_Y + 0.5;
    return [x, y, z];
  }

  applyImpulse(entity: Entity, v: { x: number; y: number; z: number }): void {
    if (!canManipulate({ peerSeat: this.identity.selfSeat(), isHost: this.role === 'host' }, entity.owner)) return;
    const phys = entity.getComponent(PhysicsComponent);
    if (phys?.state.isLocked) return;
    if (this.role === 'host') {
      phys?.applyImpulse(v);
      return;
    }
    // Guest: dispatch RPC; host re-validates on receipt.
    this.transport.send(
      { type: 'apply-impulse', entityId: entity.id, vx: v.x, vy: v.y, vz: v.z },
      { reliable: true },
    );
  }

  // ── Cosmetic tool broadcasts (issue #4 of issues--tools.md) ─────────────
  // Sender path: fire local subscribers immediately (so the sender sees its
  // own ping) and put the envelope on the unreliable channel. On the host,
  // RtcTransport.send fans the envelope out to every connected guest. Guests
  // route through the host (single peer); the host relay in handleInboundHost
  // bounces it to all other guests.
  broadcastToolMessage(toolId: string, payload: unknown): void {
    if (this.disposed) return;
    const msg: ToolBroadcast = {
      type:    'tool-broadcast',
      toolId,
      peerId:  this.identity.selfPeerId() ?? '',
      seat:    this.identity.selfSeat(),
      payload,
    };
    this.fireToolBroadcast(msg);
    this.transport.send(msg, { reliable: false });
  }

  onToolBroadcast(handler: (msg: ToolBroadcast) => void): () => void {
    this.toolBroadcastHandlers.push(handler);
    return () => {
      this.toolBroadcastHandlers = this.toolBroadcastHandlers.filter(h => h !== handler);
    };
  }

  private fireToolBroadcast(msg: ToolBroadcast): void {
    for (const h of this.toolBroadcastHandlers) h(msg);
  }

  // ── Cosmetic sound broadcasts (issue #11 of issues--asset-registry.md) ──
  // Host script calls `scene.playSound(slug)` → SceneFacade routes here.
  // We fire local subscribers immediately (so the host hears its own sound)
  // and put the envelope on the unreliable channel for guests to play.
  // Guests calling this no-op (host-only — matches the existing host-only
  // write semantics enforced by SceneFacade).
  broadcastPlaySound(slug: string): void {
    if (this.disposed) return;
    if (this.role !== 'host') return;
    const msg: PlaySoundMessage = { type: 'play-sound', slug };
    this.firePlaySound(msg);
    this.transport.send(msg, { reliable: false });
  }

  onPlaySound(handler: (msg: PlaySoundMessage) => void): () => void {
    this.playSoundHandlers.push(handler);
    return () => {
      this.playSoundHandlers = this.playSoundHandlers.filter(h => h !== handler);
    };
  }

  private firePlaySound(msg: PlaySoundMessage): void {
    for (const h of this.playSoundHandlers) h(msg);
  }

  // Dual-fire entry point for entity-input events (issue #4 of
  // issues--interaction.md). Local bus first so components and scripts on
  // the originating peer react instantly; guest peers also emit the RPC so
  // the host's per-entity bus re-fires the event for host-only scripts.
  fireInputEvent(entity: Entity, eventName: InputEventName, payload: InputEventPayload): void {
    if (this.disposed) return;
    entity.dispatchEvent(eventName, payload);
    if (this.role === 'host') return;
    const msg: GuestInputEvent = {
      type:      'guest-input-event',
      entityId:  entity.id,
      eventName,
      payload,
    };
    this.transport.send(msg, { reliable: true });
  }

  // Peer-left hook — drops every hold owned by the leaving peer's seat.
  releasePeer(peerId: string): void {
    if (this.role !== 'host') return;
    this.guestInput?.releasePeer(peerId);
  }


  // ── Inbound dispatch ─────────────────────────────────────────────────────
  private handleInbound(peerId: string, msg: WorldInboundMessage): void {
    if (this.disposed) return;
    if (this.role === 'host') this.handleInboundHost(peerId, msg);
    else                      this.handleInboundGuest(msg);
  }

  // Host receives guest inputs (hold-*, request-update, invoke-action,
  // guest-drag-*). Outbound replication echoes (entity-spawn, etc.) are
  // host-authored, so the host ignores them on inbound.
  private handleInboundHost(peerId: string, msg: WorldInboundMessage): void {
    switch (msg.type) {
      case 'hold-claim':       this.hostInput?.handleHoldClaim(peerId, msg);     return;
      case 'hold-release':     this.hostInput?.handleHoldRelease(peerId, msg);   return;
      case 'request-update':   this.hostInput?.handleRequestUpdate(peerId, msg); return;
      case 'invoke-action':    this.hostInput?.handleInvokeAction(peerId, msg);  return;
      case 'apply-impulse':    this.hostInput?.handleApplyImpulse(peerId, msg);  return;
      case 'play-card-to-table': this.hostInput?.handlePlayCardToTable(peerId, msg); return;
      case 'reorder-hand':       this.hostInput?.handleReorderHand(peerId, msg);      return;
      case 'tween-into-hand':    this.hostInput?.handleTweenIntoHand(peerId, msg);    return;
      case 'draw-from-deck':     this.hostInput?.handleDrawFromDeck(peerId, msg);     return;
      case 'shuffle-deck':       this.hostInput?.handleShuffleDeck(peerId, msg);      return;
      case 'deal-from-deck':     this.hostInput?.handleDealFromDeck(peerId, msg);     return;
      case 'spread-deck':        this.hostInput?.handleSpreadDeck(peerId, msg);       return;
      case 'peel-and-hold': {
        const result = this.hostInput?.handlePeelAndHold(peerId, msg) ?? null;
        const reply: PeelAndHoldReply = {
          type:      'peel-and-hold-reply',
          requestId: msg.requestId,
          result,
        };
        // sendTo where available so the reply only hits the requesting peer;
        // fall back to a broadcast — other peers' pendingPeelRequests maps
        // won't have the requestId, so they ignore it.
        if (this.transport.sendTo) this.transport.sendTo(peerId, reply);
        else                       this.transport.send(reply, { reliable: true });
        return;
      }
      case 'peel-and-hold-reply':
        // Host doesn't expect inbound replies. Drop.
        return;
      case 'open-search': {
        const result = this.hostInput?.handleOpenSearchRequest(peerId, msg) ?? { deckId: msg.deckId };
        const reply: OpenSearchReply = {
          type:      'open-search-reply',
          requestId: msg.requestId,
          ...result,
        };
        if (this.transport.sendTo) this.transport.sendTo(peerId, reply);
        else                       this.transport.send(reply, { reliable: true });
        return;
      }
      case 'close-search':
        this.hostInput?.handleCloseSearch(peerId, msg);
        return;
      case 'reorder-deck':
        this.hostInput?.handleReorderDeck(peerId, msg);
        return;
      case 'open-search-reply':
        // Host doesn't expect inbound replies. Drop.
        return;
      case 'guest-drag-move':  this.guestInput?.handleMessage(peerId, msg);      return;
      case 'guest-drag-start':
      case 'guest-drag-end':
        // Reserved by the wire schema but not produced today.
        return;
      case 'guest-input-event': {
        // Dual-fire RPC re-fire (issue #4 of issues--interaction.md).
        // Validate the sender's seat against the payload, drop on entity-not-
        // found, then re-fire on the named entity's bus so host-only scripts
        // observe every peer's input.
        const senderSeat = this.getPeerSeat(peerId);
        if (senderSeat === null) return;
        if (msg.payload.seat !== senderSeat) return;
        const entity = this.scene.getEntity(msg.entityId);
        if (!entity) return;
        entity.dispatchEvent(msg.eventName, msg.payload);
        return;
      }
      case 'tool-broadcast':
        // Notify local subscribers (host PingOverlay etc.), then relay to all
        // connected peers via transport.send. The original sender filters
        // its own peer id on inbound (handleInboundGuest) to avoid a
        // double-render bouncing back through the relay.
        this.fireToolBroadcast(msg);
        this.transport.send(msg, { reliable: false });
        return;
      case 'play-sound':
        // Host doesn't expect inbound play-sound — the script API is host-only.
        // Drop silently rather than relaying a guest spoof.
        return;
      default:
        // entity-spawn / entity-patch / component-patches / despawn-batch are
        // host-authored — host doesn't apply its own outbound echoes.
        return;
    }
  }

  // Mirrors applySceneMessage but writes to this World's own SceneImpl. Issue
  // #5 deletes the legacy free function once nothing imports it.
  private handleInboundGuest(msg: WorldInboundMessage): void {
    switch (msg.type) {
      case 'entity-spawn': {
        if (this.scene.has(msg.entity.id)) return;
        const ctx: SpawnContext = { scene: this.threeScene, physics: this.physics, entityScene: this.scene };
        this.scene.load([msg.entity], ctx);
        this.notify();
        return;
      }

      case 'attach-component': {
        const entity = this.scene.getEntity(msg.entityId);
        if (!entity) return;
        if (entity.components.has(msg.typeId)) return;
        const cls = componentRegistry.get(msg.typeId);
        if (!cls) return;
        const comp = new cls();
        comp.fromJSON(msg.state);
        entity.attachComponent(comp);
        const ctx: SpawnContext = { scene: this.threeScene, physics: this.physics, entityScene: this.scene };
        comp.onSpawn(ctx);
        this.notify();
        return;
      }

      case 'scene-snapshot': {
        // Defensive: skip entities the guest already has so a re-fired snapshot
        // is idempotent. State divergence resync is a future PRD-2 concern.
        const fresh = msg.entities.filter(e => !this.scene.has(e.id));
        if (fresh.length > 0) this.loadSnapshot(fresh);
        return;
      }

      case 'scene-replace': {
        // Atomic destructive reset (PRD § Save / Load). Cascade-despawn every
        // existing entity then load the new snapshot via the same path as the
        // host. Mid-drag inputs whose target entity disappears are silently
        // dropped by guest-drag-move's existing unknown-id guard.
        this.applyReplace(msg.entities);
        return;
      }

      case 'component-patches': {
        let any = false;
        for (const p of msg.patches) {
          const entity = this.scene.getEntity(p.entityId);
          if (!entity) continue;
          const comp = entity.components.get(p.typeId);
          if (!comp) continue;
          comp.applyRemoteState(p.partial);
          any = true;
        }
        if (any) this.notify();
        return;
      }

      case 'entity-patch': {
        const entity = this.scene.getEntity(msg.entityId);
        if (!entity) return;
        mergeEntityFields(entity, msg.partial);
        this.notify();
        return;
      }

      case 'despawn-batch': {
        const ctx: SpawnContext = { scene: this.threeScene, physics: this.physics, entityScene: this.scene };
        let any = false;
        // Guests mirror the host's authoritative despawn — the host's gate
        // already vetted the request, so guests `force` to avoid a divergent
        // state if the host ever does despawn the Table internally.
        for (const id of msg.entityIds) {
          const removed = this.scene.despawn(id, ctx, { force: true });
          for (const r of removed) {
            this.handles.delete(r);
            this.restPoses.delete(r);
            any = true;
          }
        }
        if (any) this.notify();
        return;
      }

      case 'hold-claim': {
        const entity = this.scene.getEntity(msg.entityId);
        if (!entity) return;
        entity.heldBy = msg.seat;
        this.notify();
        return;
      }

      case 'hold-release': {
        const entity = this.scene.getEntity(msg.entityId);
        if (!entity) return;
        entity.heldBy = null;
        this.notify();
        return;
      }

      case 'tool-broadcast': {
        // Filter own echo bouncing back through the host relay.
        if (msg.peerId === this.identity.selfPeerId()) return;
        this.fireToolBroadcast(msg);
        return;
      }

      case 'play-sound': {
        this.firePlaySound(msg);
        return;
      }

      case 'peel-and-hold-reply': {
        const resolve = this.pendingPeelRequests.get(msg.requestId);
        if (!resolve) return;
        this.pendingPeelRequests.delete(msg.requestId);
        resolve(msg.result);
        return;
      }

      case 'open-search-reply': {
        const resolve = this.pendingInspectRequests.get(msg.requestId);
        if (!resolve) return;
        this.pendingInspectRequests.delete(msg.requestId);
        if (msg.snapshot) {
          // openInspect's resolver wrapper fills in the requesting seat as
          // lockedBy when null. Pass null here to trigger that branch.
          resolve({ snapshot: msg.snapshot, lockedBy: null });
        } else if (msg.lockedBy !== undefined) {
          resolve({ snapshot: null, lockedBy: msg.lockedBy });
        } else {
          resolve(null);
        }
        return;
      }

      case 'invoke-action':
      case 'request-update':
      case 'apply-impulse':
      case 'play-card-to-table':
      case 'reorder-hand':
      case 'tween-into-hand':
      case 'draw-from-deck':
      case 'shuffle-deck':
      case 'deal-from-deck':
      case 'spread-deck':
      case 'peel-and-hold':
      case 'open-search':
      case 'close-search':
      case 'reorder-deck':
      case 'guest-drag-move':
      case 'guest-drag-start':
      case 'guest-drag-end':
      case 'guest-input-event':
        // Host-only inbound paths. Guest drops.
        return;
    }
  }

  // Late-join replay (issue #8). Host fires the entire scene as a single
  // scene-snapshot envelope so the new guest's loadSnapshot can run the
  // two-phase construction (all entities materialised before any onSpawn
  // fires) — keeps cross-entity GUID refs in component state resolvable.
  // Guests never call this on inbound peer-join (no peers connect to a guest
  // directly in our star topology).
  private handlePeerJoin(peerId: string): void {
    if (this.role !== 'host' || !this.transport.sendTo) return;
    this.transport.sendTo(peerId, { type: 'scene-snapshot', entities: this.snapshot() });
  }

  // ── Dispose ──────────────────────────────────────────────────────────────
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.unsubscribeMessage();
    this.unsubscribePeerJoin();

    if (this.physics && this.mergeBeginContact) {
      this.physics.world.removeEventListener('beginContact', this.mergeBeginContact);
      this.mergeBeginContact = null;
    }
    if (this.physics && this.mergeEndContact) {
      this.physics.world.removeEventListener('endContact', this.mergeEndContact);
      this.mergeEndContact = null;
    }

    this.scene.world = null;

    const ctx: SpawnContext = { scene: this.threeScene, physics: this.physics, entityScene: this.scene };
    for (const id of this.scene.all().map(e => e.id)) {
      this.scene.despawn(id, ctx, { force: true });
    }

    this.handles.clear();
    this.restPoses.clear();
    this.listeners = [];
    this.history_?.dispose();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  private handleFor(entity: Entity): EntityHandleImpl {
    const cached = this.handles.get(entity.id);
    if (cached && cached.entity === entity) return cached;
    const handle = new EntityHandleImpl(entity, this);
    this.handles.set(entity.id, handle);
    return handle;
  }
}

function mergeEntityFields(entity: Entity, partial: EntityFieldsPartial): void {
  if (partial.name          !== undefined) entity.name          = partial.name;
  if (partial.tags          !== undefined) entity.tags          = [...partial.tags];
  if (partial.owner         !== undefined) entity.owner         = partial.owner;
  if (partial.privateToSeat !== undefined) entity.privateToSeat = partial.privateToSeat;
  if (partial.parentId      !== undefined) entity.parentId      = partial.parentId;
  if (partial.children      !== undefined) entity.children      = [...partial.children];
  if (partial.isContained   !== undefined && entity.isContained !== partial.isContained) {
    entity.isContained = partial.isContained;
    for (const comp of entity.components.values()) {
      comp.onIsContainedChanged(partial.isContained);
    }
  }
  if (partial.customData !== undefined) {
    // Full-map overwrite (issue #6 of issues--scripting-v1.md). Per-key
    // delta is deferred — guests rebuild the Map from the supplied record.
    entity.customData = new Map(Object.entries(partial.customData));
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function normaliseCustomData(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = String(k);
    if (!key) continue;
    out[key] = v == null ? '' : String(v);
  }
  return out;
}

function normaliseTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of value) {
    const s = String(v).trim().toLowerCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// If the snapshot lacks the singleton Table entry, synthesise one from the
// spawnable definition's defaults and prepend it. Lets a legacy pre-Table-
// as-entity save round-trip cleanly through replaceScene without leaving
// the room without a play surface.
function ensureTableInSnaps(snaps: readonly EntitySerialized[]): EntitySerialized[] {
  if (snaps.some(s => s.id === TABLE_ENTITY_ID || s.type === 'table')) return [...snaps];
  const def = getSpawnable('table');
  if (!def) return [...snaps];
  const components: Record<string, object> = {};
  for (const init of def.components) components[init.typeId] = { ...init.state };
  const tableSnap: EntitySerialized = {
    id:            TABLE_ENTITY_ID,
    type:          def.type,
    name:          defaultEntityName(def.label, TABLE_ENTITY_ID),
    tags:          [...def.defaultTags],
    owner:         null,
    privateToSeat: null,
    parentId:      null,
    children:      [],
    components,
  };
  return [tableSnap, ...snaps];
}


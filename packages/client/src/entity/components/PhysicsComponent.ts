// Rigid-body physics for an entity. Slice #3 of issues--scene-graph.md.
//
// Owns a CANNON.Body whose shape is derived from the sibling MeshComponent.
// Each physics tick the host calls syncFromBody() which writes the new pose
// back into the TransformComponent's state.

import * as CANNON from 'cannon-es';
import {
  EntityComponent,
  type SpawnContext,
  type CollisionEvent,
  type EntityScene,
  type ActionContext,
  type ActionDefinition,
} from '../EntityComponent';
import { type Entity } from '../Entity';
import { TransformComponent } from './TransformComponent';
import { MeshComponent } from './MeshComponent';
import { D20_VERTICES, D20_FACES, D20_BOUNDING_SPHERE_RADIUS } from '../../dice/d20';
import { getHullForAsset, subscribeHull } from '../../physics/hullCache';
import type { HullData } from '../../physics/hullBuilder';

export type PhysicsShape = 'auto-hull' | 'box' | 'cylinder' | 'sphere';

export interface PhysicsState {
  mass:        number;
  friction:    number;
  restitution: number;
  isLocked:    boolean;
  // When true, cannon's angularFactor is set to (0,1,0) so the body may
  // only rotate about world +Y — pitch and roll are zeroed every integrate
  // step. Used by flat playing pieces (board / deck / card) so they stay
  // aligned with the table no matter what hits them. Tween-driven actions
  // (Flip) bypass integration by writing the body quaternion directly, so
  // they remain unaffected.
  yawOnly:     boolean;
  // Optional collision-shape override. When absent, buildShape falls back
  // to the sibling MeshComponent's meshKind() mapping (the historical
  // behaviour). 'auto-hull' resolves the entity's mesh asset, generates a
  // convex hull, caches it per asset URL, and scales it by transform.scale.
  shape?:      PhysicsShape;
}

export interface Vec3Like { x: number; y: number; z: number }

const REST_VEL_THRESHOLD = 0.05;

export class PhysicsComponent extends EntityComponent<PhysicsState> {
  static typeId   = 'physics';
  static requires = ['transform', 'mesh'] as const;

  body!: CANNON.Body;

  private wasMoving = false;
  private startMovingHandlers: Array<() => void> = [];
  private stopMovingHandlers:  Array<() => void> = [];
  private collideHandler: ((e: { body: CANNON.Body; contact?: unknown }) => void) | null = null;
  private entityScene: EntityScene | null = null;
  // Saved on first lock, restored on unlock. Null while unlocked.
  private priorMass: number | null = null;
  // Cannon world reference used when this component's body is removed from the
  // world while the entity is contained. Held so onIsContainedChanged can
  // re-add the same body without rebuilding it.
  private physicsWorld: CANNON.World | null = null;
  private bodyInWorld = false;
  // 'auto-hull' subscription. The first build resolves the hull cache
  // synchronously; on miss we attach to the cache and rebuild the shape
  // once the GLB load + hull compute completes.
  private hullUnsub: (() => void) | null = null;

  onSpawn(ctx: SpawnContext): void {
    const transform = this.entity.getComponent(TransformComponent)!;
    const mesh      = this.entity.getComponent(MeshComponent)!;
    this.body = buildBody(this.state, mesh, transform);
    this.entityScene = ctx.entityScene;
    this.maybeSubscribeHull();

    const [px, py, pz]     = transform.state.position;
    const [qx, qy, qz, qw] = transform.state.rotation;
    this.body.position.set(px, py, pz);
    this.body.quaternion.set(qx, qy, qz, qw);

    this.applyYawOnly(this.state.yawOnly);

    this.collideHandler = (e) => this.handleCollide(e.body);
    this.body.addEventListener('collide', this.collideHandler);

    if (ctx.physics) {
      this.physicsWorld = ctx.physics.world;
      if (!this.entity.isContained) {
        ctx.physics.addBody(this.body);
        this.bodyInWorld = true;
      }
    }

    if (this.state.isLocked) this.applyLockChange(true);
  }

  onDespawn(ctx: SpawnContext): void {
    if (this.collideHandler) {
      this.body.removeEventListener('collide', this.collideHandler);
      this.collideHandler = null;
    }
    if (ctx.physics && this.bodyInWorld) {
      ctx.physics.world.removeBody(this.body);
      this.bodyInWorld = false;
    }
    this.physicsWorld = null;
    if (this.hullUnsub) { this.hullUnsub(); this.hullUnsub = null; }
  }

  onIsContainedChanged(isContained: boolean): void {
    if (!this.body || !this.physicsWorld) return;
    if (isContained && this.bodyInWorld) {
      this.body.velocity.setZero();
      this.body.angularVelocity.setZero();
      this.physicsWorld.removeBody(this.body);
      this.bodyInWorld = false;
    } else if (!isContained && !this.bodyInWorld) {
      this.physicsWorld.addBody(this.body);
      this.bodyInWorld = true;
    }
  }

  onPropertiesChanged(changed: Partial<PhysicsState>): void {
    if (!this.body) return;
    // Mass first so a paired isLocked change captures or restores the new value.
    if (changed.mass !== undefined) {
      if (this.priorMass !== null) {
        this.priorMass = changed.mass;
      } else {
        this.body.mass = changed.mass;
        this.body.updateMassProperties();
      }
    }
    if (changed.friction    !== undefined && this.body.material)    this.body.material.friction    = changed.friction;
    if (changed.restitution !== undefined && this.body.material)    this.body.material.restitution = changed.restitution;
    if (changed.isLocked    !== undefined) this.applyLockChange(changed.isLocked);
    if (changed.yawOnly     !== undefined) this.applyYawOnly(changed.yawOnly);
  }

  // When the component opts into 'auto-hull', subscribe through the hull
  // cache so the body's shape is upgraded from its AABB fallback to a real
  // ConvexPolyhedron the moment the asset's hull finishes computing. If
  // the hull was already cached at spawn time, buildShape consumed it
  // synchronously and this subscription will be a no-op refresh.
  private maybeSubscribeHull(): void {
    if (this.state.shape !== 'auto-hull') return;
    const mesh = this.entity.getComponent(MeshComponent);
    const ref  = mesh?.state.meshRef;
    if (!ref || ref.startsWith('prim:')) return;
    if (this.hullUnsub) { this.hullUnsub(); this.hullUnsub = null; }
    this.hullUnsub = subscribeHull(ref, () => {
      // rebuildShape consults the cache again; whether the hull is real or
      // null, the resulting shape is the canonical one for this asset.
      this.rebuildShape();
    });
  }

  private applyYawOnly(yawOnly: boolean): void {
    if (!this.body) return;
    if (yawOnly) {
      this.body.angularFactor.set(0, 1, 0);
      // Zero stale pitch/roll velocity so the toggle takes effect immediately
      // instead of waiting for the next integrate step to clamp it.
      this.body.angularVelocity.x = 0;
      this.body.angularVelocity.z = 0;
    } else {
      this.body.angularFactor.set(1, 1, 1);
    }
  }

  private applyLockChange(locked: boolean): void {
    if (!this.body) return;
    if (locked && this.priorMass === null) {
      this.priorMass = this.body.mass;
      this.body.mass = 0;
      this.body.updateMassProperties();
      this.body.velocity.setZero();
      this.body.angularVelocity.setZero();
    } else if (!locked && this.priorMass !== null) {
      this.body.mass = this.priorMass;
      this.priorMass = null;
      this.body.updateMassProperties();
      this.body.wakeUp();
    }
  }

  // ── Per-tick host loop ──────────────────────────────────────────────────
  // Push CANNON's integrated pose into the TransformComponent. Also detects
  // start/stop-moving transitions and notifies subscribers.
  syncToTransform(): void {
    const transform = this.entity.getComponent(TransformComponent)!;
    const p = this.body.position;
    const q = this.body.quaternion;
    transform.setState({
      position: [p.x, p.y, p.z],
      rotation: [q.x, q.y, q.z, q.w],
      scale:    transform.state.scale,
    });

    const moving = !this.isAtRest();
    if (moving && !this.wasMoving) {
      for (const h of this.startMovingHandlers) h();
    } else if (!moving && this.wasMoving) {
      for (const h of this.stopMovingHandlers) h();
    }
    this.wasMoving = moving;
  }

  // ── Methods (PRD § Physics Component) ───────────────────────────────────
  // Rebuild the body shape from the current sibling MeshComponent. Used when
  // sibling components (DeckComponent) resize the mesh and need the body's
  // hitbox to follow. Issue #2 of issues--deck.md.
  rebuildShape(): void {
    if (!this.body) return;
    const mesh      = this.entity.getComponent(MeshComponent);
    const transform = this.entity.getComponent(TransformComponent);
    if (!mesh || !transform) return;
    while (this.body.shapes.length > 0) this.body.removeShape(this.body.shapes[0]);
    const [ox, oy, oz] = mesh.meshOffset();
    this.body.addShape(buildShapeFor(this.state, mesh, transform), new CANNON.Vec3(ox, oy, oz));
    this.body.updateBoundingRadius();
    this.body.aabbNeedsUpdate = true;
    this.body.updateMassProperties();
  }

  getVelocity(): Vec3Like {
    const v = this.body.velocity;
    return { x: v.x, y: v.y, z: v.z };
  }

  setVelocity(v: Vec3Like): void {
    this.body.velocity.set(v.x, v.y, v.z);
    this.body.wakeUp();
  }

  applyForce(f: Vec3Like): void {
    this.body.applyForce(new CANNON.Vec3(f.x, f.y, f.z));
  }

  applyImpulse(i: Vec3Like): void {
    if (this.state.isLocked) return;
    this.entity.cancelTween();
    this.body.applyImpulse(new CANNON.Vec3(i.x, i.y, i.z));
    this.body.wakeUp();
  }

  isAtRest(): boolean {
    return this.body.velocity.length() + this.body.angularVelocity.length() < REST_VEL_THRESHOLD;
  }

  // ── Context menu ───────────────────────────────────────────────────────
  // Lock toggle. Authority is enforced by dispatchAction (host) and
  // HostInputDispatcher.handleInvokeAction (guest RPC) — both gate on
  // canManipulate, so the action body can flip state unconditionally.
  getActions(_ctx: ActionContext): ActionDefinition[] {
    return [{
      name:  'lock-toggle',
      label: this.state.isLocked ? 'Unlock movement' : 'Lock movement',
    }];
  }

  onAction(name: string, _ctx: ActionContext): void {
    if (name === 'lock-toggle') {
      this.setState({ isLocked: !this.state.isLocked } as Partial<PhysicsState>);
    }
  }

  // ── Events ──────────────────────────────────────────────────────────────
  subscribeStartMoving(h: () => void): () => void {
    this.startMovingHandlers.push(h);
    return () => { this.startMovingHandlers = this.startMovingHandlers.filter(x => x !== h); };
  }

  subscribeStopMoving(h: () => void): () => void {
    this.stopMovingHandlers.push(h);
    return () => { this.stopMovingHandlers = this.stopMovingHandlers.filter(x => x !== h); };
  }

  private handleCollide(otherBody: CANNON.Body): void {
    const otherEntity = this.entityScene ? findEntityByBody(this.entityScene, otherBody) : undefined;
    const event: CollisionEvent = {};
    for (const comp of this.entity.components.values()) {
      comp.onCollision(otherEntity ?? this.entity, event);
    }
  }
}

function buildBody(state: PhysicsState, mesh: MeshComponent, transform: TransformComponent): CANNON.Body {
  const material = new CANNON.Material({ friction: state.friction, restitution: state.restitution });
  const shape    = buildShapeFor(state, mesh, transform);
  const body = new CANNON.Body({
    mass:           state.mass,
    material,
    linearDamping:  0.3,
    angularDamping: 0.5,
  });
  const [ox, oy, oz] = mesh.meshOffset();
  body.addShape(shape, new CANNON.Vec3(ox, oy, oz));
  return body;
}

function buildShapeFor(state: PhysicsState, mesh: MeshComponent, transform: TransformComponent): CANNON.Shape {
  if (state.shape === 'auto-hull') {
    const hullShape = buildAutoHullShape(mesh, transform);
    if (hullShape) return hullShape;
    // Fall through to the AABB fallback below. The async hull-cache
    // subscription in onSpawn will rebuild the shape once the hull is ready.
  }
  const [hx, hy, hz] = mesh.halfExtents();
  switch (mesh.meshKind()) {
    case 'meeple':       return new CANNON.Cylinder(hx, hx, hy * 2, 12);
    case 'cylinder':     return new CANNON.Cylinder(hx, hx, hy * 2, 64);
    case 'icosahedron':  return buildIcosahedronShape(hx);
    case 'cube':
    case 'unknown':
    default:             return new CANNON.Box(new CANNON.Vec3(hx, hy, hz));
  }
}

// Looks the entity's mesh asset up in the hull cache. Returns the built
// polyhedron on cache hit, null on miss/failure (caller falls back to AABB
// and emits a warning). Cached hull vertices live in model space; we scale
// by transform.scale here, matching the existing d20 pattern.
function buildAutoHullShape(mesh: MeshComponent, transform: TransformComponent): CANNON.ConvexPolyhedron | null {
  const ref = mesh.state.meshRef;
  if (!ref || ref.startsWith('prim:')) {
    console.warn(`[PhysicsComponent] auto-hull requested on non-asset meshRef "${ref}"; using AABB fallback`);
    return null;
  }
  const hull = getHullForAsset(ref);
  if (hull === undefined) return null;          // not yet loaded
  if (hull === null) {
    console.warn(`[PhysicsComponent] auto-hull unavailable for ${ref}; using AABB fallback`);
    return null;
  }
  return buildPolyhedronFromHull(hull, transform.state.scale);
}

function buildPolyhedronFromHull(hull: HullData, scale: readonly [number, number, number]): CANNON.ConvexPolyhedron {
  const [sx, sy, sz] = scale;
  const vertices = hull.vertices.map(([x, y, z]) => new CANNON.Vec3(x * sx, y * sy, z * sz));
  const faces    = hull.faces.map((f) => [...f]);
  return new CANNON.ConvexPolyhedron({ vertices, faces });
}

// d20 hull. `boundingRadius` is the bounding-sphere radius of the visible
// mesh; the same scaling factor that MeshComponent.buildD20 applies to the
// raw vertex set is used here so the hull and the mesh are coincident.
function buildIcosahedronShape(boundingRadius: number): CANNON.ConvexPolyhedron {
  const scale = boundingRadius / D20_BOUNDING_SPHERE_RADIUS;
  const vertices = D20_VERTICES.map(
    ([x, y, z]) => new CANNON.Vec3(x * scale, y * scale, z * scale),
  );
  const faces = D20_FACES.map(f => [f[0], f[1], f[2]]);
  return new CANNON.ConvexPolyhedron({ vertices, faces });
}

// Linear scan; fine for PoC scale. A body→entity index is a future optimisation.
function findEntityByBody(scene: EntityScene, body: CANNON.Body): Entity | undefined {
  for (const e of scene.all()) {
    const phys = e.getComponent(PhysicsComponent);
    if (phys?.body === body) return e;
  }
  return undefined;
}

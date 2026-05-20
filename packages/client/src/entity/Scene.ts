// Per-World entity store. Owns entities + the topological component lifecycle
// (spawn / despawn). Instances are constructed by `World`; previously a single
// process-global `Scene` singleton lived here, but issue #5 of issues--arch.md
// retired it so tests can run multiple Worlds in parallel without colliding.

import { Entity, defaultEntityName } from './Entity';
import { type SpawnContext, type ComponentReplicator } from './EntityComponent';
import { componentRegistry, type ComponentRegistry } from './ComponentRegistry';
import { getSpawnable } from './SpawnableRegistry';
import { type SeatIndex } from '../seats/SeatLayout';
import {
  TABLE_ENTITY_ID,
  DEFAULT_TABLE_HALF_WIDTH,
  DEFAULT_TABLE_HALF_DEPTH,
} from './tableEntity';
import { TransformComponent } from './components/TransformComponent';
import { MeshComponent } from './components/MeshComponent';
import { TableComponent } from './components/TableComponent';

export interface TableBounds {
  halfWidth: number;
  halfDepth: number;
}

// Per-entity snapshot — also the save-format leaf (PRD § Save / Load).
export interface EntitySerialized {
  id:            string;
  type:          string;
  name:          string;
  tags:          string[];
  owner:         SeatIndex | null;
  privateToSeat: SeatIndex | null;
  parentId:      string | null;
  children:      string[];
  isContained?:  boolean;  // optional in serialised form for back-compat with pre-deck snapshots
  customData?:   Record<string, string>;  // optional for back-compat with pre-scripting saves
  components:    Record<string, object>;  // typeId → component.toJSON()
}

export class SceneImpl {
  private entities = new Map<string, Entity>();
  private registry: ComponentRegistry = componentRegistry;
  // Set by World on host construction; null on guest. Components on entities
  // added to this scene inherit this reference, which they use to enqueue
  // replication patches. Issue #6 of issues--arch.md.
  world: ComponentReplicator | null = null;

  getEntity(guid: string): Entity | undefined {
    return this.entities.get(guid);
  }

  has(id: string): boolean {
    return this.entities.has(id);
  }

  all(): Entity[] {
    return [...this.entities.values()];
  }

  // Returns the singleton Table entity, or undefined when the scene has not
  // yet bootstrapped (host pre-spawn) or the snapshot being loaded does not
  // include one (legacy save — slice 7 re-bootstraps).
  getTable(): Entity | undefined {
    return this.entities.get(TABLE_ENTITY_ID);
  }

  // World-space half-extents of the Table's play surface. Derived from the
  // Table's MeshComponent half-extents × TransformComponent.scale (X,Z only —
  // surface plane is always world y=0). Falls back to default rect-table
  // dimensions while the Table has not been spawned (e.g. on a guest before
  // the first scene snapshot arrives).
  getTableBounds(): TableBounds {
    const table = this.getTable();
    if (!table) {
      return { halfWidth: DEFAULT_TABLE_HALF_WIDTH, halfDepth: DEFAULT_TABLE_HALF_DEPTH };
    }
    const mesh      = table.getComponent(MeshComponent);
    const transform = table.getComponent(TransformComponent);
    if (!mesh || !transform) {
      return { halfWidth: DEFAULT_TABLE_HALF_WIDTH, halfDepth: DEFAULT_TABLE_HALF_DEPTH };
    }
    const [hx, _hy, hz] = mesh.halfExtents();
    const [sx, _sy, sz] = transform.state.scale;
    return { halfWidth: hx * sx, halfDepth: hz * sz };
  }

  add(entity: Entity): void {
    if (this.entities.has(entity.id)) {
      throw new Error(`Entity already in scene: ${entity.id}`);
    }
    this.entities.set(entity.id, entity);
    entity.scene = this;
    for (const comp of entity.components.values()) comp.world = this.world;
  }

  removeEntity(id: string): void {
    const entity = this.entities.get(id);
    if (!entity) return;
    this.entities.delete(id);
    entity.scene = null;
    for (const comp of entity.components.values()) comp.world = null;
  }

  // Test seam: swap the registry that load() consults. Production uses the
  // process-global componentRegistry singleton.
  setRegistry(registry: ComponentRegistry): void {
    this.registry = registry;
  }

  // Two-pass load.
  //   Phase 1: construct each Entity, instantiate its components, call
  //            fromJSON(state). After this pass the scene is fully populated as
  //            data — no view artefacts, no onSpawn.
  //   Phase 2: walk each entity's components in topological order calling
  //            onSpawn(ctx). Cross-entity GUID refs in component state resolve
  //            against the now-populated scene.
  load(snapshots: readonly EntitySerialized[], ctx: SpawnContext): Entity[] {
    const created: Entity[] = [];

    for (const snap of snapshots) {
      const entity = new Entity({
        id:            snap.id,
        type:          snap.type,
        name:          snap.name,
        tags:          snap.tags,
        owner:         snap.owner,
        privateToSeat: snap.privateToSeat,
        parentId:      snap.parentId,
        children:      snap.children,
        isContained:   snap.isContained,
        customData:    snap.customData,
      });
      for (const [typeId, state] of Object.entries(snap.components)) {
        const cls = this.registry.get(typeId);
        if (!cls) throw new Error(`Unknown component typeId in snapshot: ${typeId}`);
        const comp = new cls();
        comp.fromJSON(state);
        entity.attachComponent(comp);
      }
      this.add(entity);
      created.push(entity);
    }

    for (const entity of created) {
      const typeIds = [...entity.components.keys()];
      const order   = this.registry.getSpawnOrder(typeIds);
      for (const cls of order) {
        const comp = entity.components.get(cls.typeId)!;
        comp.onSpawn(ctx);
      }
    }

    return created;
  }

  // PRD § Spawnables — spawn flow.
  //   1. Look up SpawnableDef by type.
  //   2. Construct Entity with new UUID, type, default tags.
  //   3. Instantiate each component class via registry; call fromJSON(state).
  //   4. Call onSpawn(ctx) per component in topological order.
  // The Table is a singleton: spawning a second Table throws (PRD §
  // Locking enforcement). Internal lifecycle (e.g. snapshot load via
  // `load()`) bypasses this gate because it never goes through `spawn`.
  spawn(type: string, ctx: SpawnContext, opts: { id?: string } = {}): Entity {
    const def = getSpawnable(type);
    if (!def) throw new Error(`Unknown spawnable type: ${type}`);
    if (type === 'table' && this.getTable() !== undefined) {
      throw new Error('Cannot spawn a second Table: the singleton Table entity already exists');
    }

    const id = opts.id ?? newGuid();
    const entity = new Entity({
      id,
      type:  def.type,
      name:  defaultEntityName(def.label, id),
      tags:  def.defaultTags,
    });

    for (const init of def.components) {
      const cls = this.registry.get(init.typeId);
      if (!cls) throw new Error(`Spawnable ${type}: unknown component ${init.typeId}`);
      const comp = new cls();
      comp.fromJSON(init.state);
      entity.attachComponent(comp);
    }

    this.add(entity);

    const order = this.registry.getSpawnOrder(def.components.map(c => c.typeId));
    for (const cls of order) {
      entity.components.get(cls.typeId)!.onSpawn(ctx);
    }

    return entity;
  }

  // PRD § Despawn — recursive depth-first descent; reverse-topological
  // onDespawn per entity; remove from scene + parent.children.
  //
  // The Table singleton is undeletable (PRD § Locking enforcement); calling
  // despawn on an entity carrying TableComponent throws. Internal lifecycle
  // operations that legitimately need to tear the Table down (replaceScene,
  // World.dispose) pass `{ force: true }` to bypass the gate.
  despawn(id: string, ctx: SpawnContext, opts: { force?: boolean } = {}): string[] {
    if (!opts.force) {
      const target = this.entities.get(id);
      if (target?.hasComponent(TableComponent)) {
        throw new Error(`Cannot despawn the Table entity (${id}): it is a locked singleton`);
      }
    }
    const removed: string[] = [];
    this.cascadeDespawn(id, ctx, removed);
    return removed;
  }

  private cascadeDespawn(id: string, ctx: SpawnContext, out: string[]): void {
    const entity = this.entities.get(id);
    if (!entity) return;
    for (const childId of [...entity.children]) {
      this.cascadeDespawn(childId, ctx, out);
    }
    const typeIds = [...entity.components.keys()];
    const order   = this.registry.getSpawnOrder(typeIds);
    for (let i = order.length - 1; i >= 0; i--) {
      entity.components.get(order[i].typeId)!.onDespawn(ctx);
    }
    if (entity.parentId) {
      const parent = this.entities.get(entity.parentId);
      if (parent) parent.children = parent.children.filter(c => c !== id);
    }
    this.entities.delete(id);
    entity.scene = null;
    for (const comp of entity.components.values()) comp.world = null;
    out.push(id);
  }
}

export function newGuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older runtimes (test envs without crypto.randomUUID).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Walk an entity to its serialised snapshot. Mirrors the load() input shape so
// the round-trip is symmetric.
export function entityToSerialized(e: Entity): EntitySerialized {
  const components: Record<string, object> = {};
  for (const [typeId, comp] of e.components) {
    components[typeId] = comp.toJSON();
  }
  const out: EntitySerialized = {
    id:            e.id,
    type:          e.type,
    name:          e.name,
    tags:          [...e.tags],
    owner:         e.owner,
    privateToSeat: e.privateToSeat,
    parentId:      e.parentId,
    children:      [...e.children],
    isContained:   e.isContained,
    components,
  };
  // Omit when empty so pre-scripting saves stay byte-identical and the
  // round-trip on entities that never used customData stays clean.
  if (e.customData.size > 0) {
    out.customData = Object.fromEntries(e.customData);
  }
  return out;
}

// Script-facing read surface over the host's SceneImpl. Constructed fresh
// each Run so the EntityFacades it produces are scoped to that Run; once
// #5 lands, listener registrations live on those per-Run wrappers.
//
// `getObjectById` and `getObjectsByTag` lazily wrap raw Entities, caching
// by entity id so a single Run sees a stable identity for any given
// entity (script code can rely on `===` between two lookups).
//
// `playSound(slug)` (issue #11 of issues--asset-registry.md) bounces the
// slug through ScriptRunContext.playSound, which the host wires to
// World.broadcastPlaySound. Unknown / wrong-typed slugs no-op + warn.

import { type EntityScene } from '../entity/EntityComponent';
import { EntityFacade, type ScriptRunContext } from './EntityFacade';
import { type BagOps } from './BagFacade';
import { type AssetEntry, type AssetType } from '../assets/Manifest';
import { TABLE_ENTITY_ID } from '../entity/tableEntity';
import { type StickerOpts } from '../entity/components/attachSticker';
import { ElementHandle, entitySceneLookup } from '../entity/components/ElementHandle';
import { SurfaceComponent } from '../entity/components/SurfaceComponent';
import { type SeatIndex } from '../seats/SeatLayout';
import { type TurnState } from '../seats/TurnTracker';
import { type TurnsBridge } from './TurnsBridge';

export interface SceneFacadeOptions {
  // Optional asset-slug lookup used to validate `playSound` slugs against
  // the live catalog (base + primitives + host's custom draft). Defaults to
  // no validation — slugs are accepted and pushed through to AssetService,
  // which will resolve to a `broken` status for unknown slugs and the
  // SoundPlayer skips. Wiring the lookup adds an actionable sandbox warning.
  // Also backs `scene.assets.get(slug)` (issue #12).
  lookupSlug?: (slug: string) => AssetEntry | undefined;
  // Backs `scene.assets.list({ type })`. Defaults to `() => []` so scripts
  // running without a wired AssetService see an empty catalog rather than
  // crashing.
  listAssets?: (opts?: { type?: AssetType }) => AssetEntry[];
  // Host-only sticker compositor (issue #9, refactored for issue #2 of
  // issues--ui-surface-refactor.md). Returns `{ surfaceId, elementId }` —
  // the surface entity id and the new element id appended to its
  // `state.elements` array — or null if the host can't honour the request
  // (unknown parent, missing mesh, no-op contexts). When absent (e.g.
  // guest, unit tests), `scene.attachSticker` warns and no-ops.
  attachSticker?: (parentId: string, opts: StickerOpts) => { surfaceId: string; elementId: string } | null;
  // Host-only turn tracker bridge backing `scene.turns`. Reads run through
  // `getState`; mutations dispatch through the supplied callbacks which the
  // host wires to `RoomStateManager.dispatchTurnAction`. Absent on guests —
  // the TurnsApi then warns and no-ops on mutating methods, but still reads
  // through if a `getState` is wired against a `RoomStateClient`.
  turns?: TurnsBridge;
  // Host-only bag operations backing `EntityFacade.bag`. World wires these
  // against BagService. Absent on guests; BagFacade then warns and no-ops.
  // Issue #4 of issues--bag.md.
  bagOps?: BagOps;
}

// Read-only catalog surface exposed as `scene.assets`. Returns deeply frozen
// AssetEntry copies so a buggy script can't mutate the host's manifest by
// holding references.
export class AssetsApi {
  private readonly opts: SceneFacadeOptions;

  constructor(opts: SceneFacadeOptions) {
    this.opts = opts;
  }

  get(slug: string): Readonly<AssetEntry> | null {
    if (typeof slug !== 'string' || slug.length === 0) return null;
    const lookup = this.opts.lookupSlug;
    if (!lookup) return null;
    const entry = lookup(slug);
    return entry ? freezeEntry(entry) : null;
  }

  list(opts: { type?: AssetType } = {}): ReadonlyArray<Readonly<AssetEntry>> {
    const list = this.opts.listAssets;
    const raw  = list ? list(opts) : [];
    return Object.freeze(raw.map(freezeEntry));
  }
}

function freezeEntry(entry: AssetEntry): Readonly<AssetEntry> {
  const copy: AssetEntry = {
    slug:    entry.slug,
    name:    entry.name,
    type:    entry.type,
    url:     entry.url,
    preload: entry.preload,
  };
  if (entry.description !== undefined) copy.description = entry.description;
  if (entry.tags !== undefined)        copy.tags = Object.freeze([...entry.tags]) as string[];
  return Object.freeze(copy);
}

export class SceneFacade {
  public readonly assets: AssetsApi;
  public readonly turns:  TurnsApi;
  private readonly scene: EntityScene;
  private readonly ctx:   ScriptRunContext;
  private readonly opts:  SceneFacadeOptions;
  private readonly cache = new Map<string, EntityFacade>();

  constructor(scene: EntityScene, ctx: ScriptRunContext, opts: SceneFacadeOptions = {}) {
    this.scene  = scene;
    this.ctx    = ctx;
    this.opts   = opts;
    this.assets = new AssetsApi(opts);
    this.turns  = new TurnsApi(opts.turns, (msg) => this.warn(msg));
    // Thread bag ops + entity wrapping through the run context so
    // EntityFacade.bag can reach them. Set unconditionally so a guest scope
    // (opts.bagOps undefined) leaves ctx.bagOps undefined and the facade
    // warn-and-no-ops; wrapEntity is always wired so contents/pickRandom
    // hand back the same cached EntityFacade instances getObjectById serves.
    if (opts.bagOps) ctx.bagOps = opts.bagOps;
    ctx.wrapEntity = (id: string) => this.getObjectById(id);
  }

  getObjectById(id: string): EntityFacade | undefined {
    const entity = this.scene.getEntity(id);
    if (!entity) return undefined;
    return this.facadeFor(entity.id);
  }

  // One-line wrapper over `getObjectById(TABLE_ENTITY_ID)` so scripts can
  // reach the singleton Table without knowing the magic GUID. Returns
  // undefined only on a guest script context that runs before the Table has
  // replicated, or on an empty scene during legacy-snapshot load.
  getTable(): EntityFacade | undefined {
    return this.getObjectById(TABLE_ENTITY_ID);
  }

  // Returns every entity whose `tags` includes `tag`. Empty array on no match.
  getObjectsByTag(tag: string): EntityFacade[] {
    const out: EntityFacade[] = [];
    for (const entity of this.scene.all()) {
      if (entity.tags.includes(tag)) out.push(this.facadeFor(entity.id));
    }
    return out;
  }

  // Composes a child surface entity (prim:plane mesh + SurfaceComponent)
  // and appends one element to that surface's `state.elements` array on
  // `parent`'s requested face. Returns an `ElementHandle` so the script can
  // attach event listeners and mutate the element's data. Host-only — when
  // not wired (guest, unit tests without a configured callback) the call
  // warns and returns null.
  attachSticker(parent: EntityFacade | null | undefined, opts: StickerOpts): ElementHandle | null {
    if (!parent) {
      this.warn('scene.attachSticker: parent is required');
      return null;
    }
    if (!this.opts.attachSticker) {
      this.warn('scene.attachSticker: no-op (host-only API; not running on host)');
      return null;
    }
    const result = this.opts.attachSticker(parent.id, opts);
    if (!result) return null;
    return new ElementHandle(result.surfaceId, result.elementId, entitySceneLookup(this.scene), this.ctx);
  }

  // Look up an existing element on a surface by id and wrap as an
  // ElementHandle. Returns null when the surface entity is gone, has no
  // SurfaceComponent, or has no element with that id. Used by scripts that
  // persist element ids across Runs — the ElementHandle returned from
  // `attachSticker` is per-Run (its listener registrations live on the
  // active Run's context), so a script that wants to re-attach listeners
  // after a Run swap calls `getElement` to obtain a fresh handle.
  getElement(surfaceId: string, elementId: string): ElementHandle | null {
    const e = this.scene.getEntity(surfaceId);
    if (!e) return null;
    const surface = e.getComponent(SurfaceComponent);
    if (!surface) return null;
    if (!surface.getElement(elementId)) return null;
    return new ElementHandle(surfaceId, elementId, entitySceneLookup(this.scene), this.ctx);
  }

  // Trigger a sound effect on every peer (including the host). Host-only —
  // when no `playSound` callback is wired (guest, or unit tests), the call
  // no-ops with a sandbox warning. Unknown slugs and wrong-type slugs also
  // warn and no-op.
  playSound(slug: string): void {
    if (typeof slug !== 'string' || slug.length === 0) {
      this.warn(`scene.playSound: ignoring invalid slug ${JSON.stringify(slug)}`);
      return;
    }
    if (!this.ctx.playSound) {
      this.warn(`scene.playSound("${slug}"): no-op (host-only API; not running on host)`);
      return;
    }
    const lookup = this.opts.lookupSlug;
    if (lookup) {
      const found = lookup(slug);
      if (!found) {
        this.warn(`scene.playSound("${slug}"): unknown asset slug — no-op`);
        return;
      }
      if (found.type !== 'sound') {
        this.warn(`scene.playSound("${slug}"): asset is type "${found.type}", not "sound" — no-op`);
        return;
      }
    }
    this.ctx.playSound(slug);
  }

  private warn(message: string): void {
    if (this.ctx.warn) { this.ctx.warn(message); return; }
    // Fallback to console.warn so a missing test sink doesn't swallow.
    if (typeof console !== 'undefined') console.warn('[script]', message);
  }

  private facadeFor(id: string): EntityFacade {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const entity = this.scene.getEntity(id);
    if (!entity) throw new Error(`SceneFacade.facadeFor: entity ${id} vanished`);
    const fresh = new EntityFacade(entity, this.ctx);
    this.cache.set(id, fresh);
    return fresh;
  }
}

// Script-facing turn-tracker surface, exposed as `scene.turns`. Reads delegate
// to the bridge's `getState`; mutations dispatch through callbacks routed by
// the host to `RoomStateManager.dispatchTurnAction`. On contexts without a
// bridge (guest scripts, unit tests), mutations warn-and-no-op and reads
// return safe defaults.
export class TurnsApi {
  private readonly bridge: TurnsBridge | undefined;
  private readonly warn:   (message: string) => void;

  constructor(bridge: TurnsBridge | undefined, warn: (message: string) => void) {
    this.bridge = bridge;
    this.warn   = warn;
  }

  enable(order?: SeatIndex[]): void {
    if (!this.requireHost('enable')) return;
    this.bridge!.dispatch({ kind: 'enable', order: order ? [...order] : undefined });
  }

  disable(): void {
    if (!this.requireHost('disable')) return;
    this.bridge!.dispatch({ kind: 'disable', endedBy: 'script' });
  }

  next(): void {
    if (!this.requireHost('next')) return;
    this.bridge!.dispatch({ kind: 'next', endedBy: 'script' });
  }

  setActive(seat: SeatIndex): void {
    if (!this.requireHost('setActive')) return;
    this.bridge!.dispatch({ kind: 'setActive', seat, endedBy: 'script' });
  }

  setOrder(order: SeatIndex[]): void {
    if (!this.requireHost('setOrder')) return;
    this.bridge!.dispatch({ kind: 'setOrder', order: [...order] });
  }

  isEnabled(): boolean {
    return this.readState()?.enabled ?? false;
  }

  getActive(): SeatIndex | null {
    return this.readState()?.activeSeat ?? null;
  }

  getOrder(): SeatIndex[] {
    const s = this.readState();
    return s ? [...s.order] : [];
  }

  getTurnNumber(): number {
    return this.readState()?.turnNumber ?? 0;
  }

  private readState(): TurnState | null {
    return this.bridge?.getState() ?? null;
  }

  private requireHost(method: string): boolean {
    if (this.bridge?.dispatch) return true;
    this.warn(`scene.turns.${method}: no-op (host-only API; not running on host)`);
    return false;
  }
}

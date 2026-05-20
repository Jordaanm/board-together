// Script-facing facade over a BagComponent. Returned from `EntityFacade.bag`
// for any entity carrying a BagComponent. Host-only — guests see no-ops via
// missing `ctx.bagOps`. Issue #4 of issues--bag.md.

import { type Entity } from '../entity/Entity';
import { BagComponent } from '../entity/components/BagComponent';
import { type EntityFacade, type ScriptRunContext } from './EntityFacade';

// Host wiring: the three verbs the bag facade calls into. World implements
// these against `BagService` (add / remove / pickRandomNoHold). Absent on
// guests (and unit-test scripting that doesn't wire the host); the facade
// degrades to no-ops in that case.
export interface BagOps {
  add:        (bagId: string, entityId: string) => boolean;
  remove:     (bagId: string, entityId: string) => boolean;
  pickRandom: (bagId: string) => string | null;
}

type EntityRef = string | { id: string } | null | undefined;

function refId(ref: EntityRef): string | null {
  if (ref === null || ref === undefined) return null;
  if (typeof ref === 'string') return ref;
  if (typeof ref.id === 'string') return ref.id;
  return null;
}

export class BagFacade {
  constructor(
    private readonly bag_: Entity,
    private readonly ctx:  ScriptRunContext,
  ) {}

  // Move an entity into this bag. Detaches from any prior parent (loose,
  // in a deck, in another bag) before absorbing. No-op + warn on a guest
  // context (no host wiring).
  add(target: EntityFacade | { id: string } | string | null | undefined): boolean {
    const id = refId(target);
    if (id === null) return false;
    const ops = this.ctx.bagOps;
    if (!ops) {
      this.ctx.warn?.('bag.add: no-op (host-only API; not running on host)');
      return false;
    }
    return ops.add(this.bag_.id, id);
  }

  // Remove a specific entity from this bag, dropping it at the bag's
  // current position. Returns false when the entity isn't a member.
  remove(target: EntityFacade | { id: string } | string | null | undefined): boolean {
    const id = refId(target);
    if (id === null) return false;
    const ops = this.ctx.bagOps;
    if (!ops) {
      this.ctx.warn?.('bag.remove: no-op (host-only API; not running on host)');
      return false;
    }
    return ops.remove(this.bag_.id, id);
  }

  // Pop a uniform-random item. Returns a facade for the picked entity, or
  // null on empty bag / missing host wiring.
  pickRandom(): EntityFacade | null {
    const ops = this.ctx.bagOps;
    if (!ops) {
      this.ctx.warn?.('bag.pickRandom: no-op (host-only API; not running on host)');
      return null;
    }
    const id = ops.pickRandom(this.bag_.id);
    if (id === null) return null;
    return this.ctx.wrapEntity?.(id) ?? null;
  }

  // Fresh array of EntityFacades for current contents — mutating the
  // returned array does not affect the bag's state.
  contents(): EntityFacade[] {
    const bagC = this.bag_.getComponent(BagComponent);
    if (!bagC) return [];
    const wrap = this.ctx.wrapEntity;
    const out: EntityFacade[] = [];
    if (!wrap) return out;
    for (const id of bagC.state.contents) {
      const facade = wrap(id);
      if (facade) out.push(facade);
    }
    return out;
  }

  has(id: string): boolean {
    const bagC = this.bag_.getComponent(BagComponent);
    if (!bagC) return false;
    return bagC.state.contents.includes(id);
  }

  size(): number {
    const bagC = this.bag_.getComponent(BagComponent);
    if (!bagC) return 0;
    return bagC.state.contents.length;
  }
}

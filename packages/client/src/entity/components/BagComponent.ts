// Heterogeneous container for arbitrary entities. Issue #1 of issues--bag.md.
//
// Owns `contents: string[]` (entity ids, insertion order) plus optional
// `acceptComponents` and `requiredTags` filters. Exposes `canAccept(entity)`
// for MergeService's release-recheck path (issue #2). `onTryGrab` returns
// null in this slice; the random-pick gesture lands in issue #3.

import {
  EntityComponent,
  type SpawnContext,
  type GrabIntent,
} from '../EntityComponent';
import { type PropertyDef } from '../propertySchema';
import { type Entity } from '../Entity';
import { ZoneComponent } from './ZoneComponent';
import { TableComponent } from './TableComponent';
import { SnapPointsComponent } from './SnapPointsComponent';

export interface BagState {
  contents:          string[];
  // Singular/plural noun used by the hover tooltip ("12 dice", "3 tokens").
  // Per-instance, host-editable, replicated.
  label:             string;
  acceptComponents?: string[];
  // Optional tag whitelist. Entity must carry every tag in this list (AND-match)
  // to be admitted by canAccept. Empty / undefined means no constraint.
  requiredTags?:     string[];
}

export class BagComponent extends EntityComponent<BagState> {
  static typeId   = 'bag';
  static label    = 'Bag';
  static requires = ['transform', 'mesh', 'physics'] as const;
  static propertySchema: readonly PropertyDef<BagState>[] = [
    { key: 'label', label: 'Label', type: 'string' },
    {
      key:   'requiredTags',
      label: 'Required tags',
      type:  'tags',
      get:   (s) => s.requiredTags ?? [],
      set:   (v) => {
        const next = Array.isArray(v) ? (v as string[]).filter(t => typeof t === 'string') : [];
        return next.length > 0 ? { requiredTags: next } : { requiredTags: undefined };
      },
    },
  ];

  onSpawn(_ctx: SpawnContext): void {}
  onPropertiesChanged(_changed: Partial<BagState>): void {}

  toJSON(): object {
    const out: BagState = {
      contents: [...this.state.contents],
      label:    this.state.label,
    };
    if (this.state.acceptComponents !== undefined) {
      out.acceptComponents = [...this.state.acceptComponents];
    }
    if (this.state.requiredTags !== undefined) {
      out.requiredTags = [...this.state.requiredTags];
    }
    return out;
  }

  fromJSON(o: object): void {
    const raw = o as Partial<BagState>;
    this.state = {
      contents: raw.contents ? [...raw.contents] : [],
      label:    raw.label    ?? 'items',
      ...(raw.acceptComponents !== undefined
        ? { acceptComponents: [...raw.acceptComponents] }
        : {}),
      ...(raw.requiredTags !== undefined
        ? { requiredTags: [...raw.requiredTags] }
        : {}),
    };
  }

  // Gate consulted by MergeService.recheckMergeOverlaps. Refuses Zones / the
  // Table singleton (ambient fixtures that must never get absorbed), refuses
  // ancestors of this bag (cycle guard for bag-in-bag-in-bag), and respects
  // the optional acceptComponents + requiredTags whitelists when set.
  canAccept(entity: Entity): boolean {
    if (entity === this.entity) return false;
    if (entity.hasComponent(ZoneComponent))       return false;
    if (entity.hasComponent(TableComponent))      return false;
    if (entity.hasComponent(SnapPointsComponent)) return false;
    if (this.isAncestor(entity)) return false;
    const filter = this.state.acceptComponents;
    if (filter && filter.length > 0) {
      for (const typeId of filter) {
        if (!entity.components.has(typeId)) return false;
      }
    }
    const tags = this.state.requiredTags;
    if (tags && tags.length > 0) {
      for (const tag of tags) {
        if (!entity.tags.includes(tag)) return false;
      }
    }
    return true;
  }

  // Short-press-drag on a non-empty bag returns a peel intent so the gesture
  // dispatcher routes through BagService.pickRandom. Empty bag and long-press
  // both fall through to whole-entity carry. Issue #3 of issues--bag.md.
  onTryGrab(isLongPress: boolean): GrabIntent | null {
    if (isLongPress) return null;
    if (this.state.contents.length === 0) return null;
    return { kind: 'peel', sourceId: this.entity.id };
  }

  // True when `candidate` is `this.entity` itself or an ancestor of it via
  // parentId. Walks at most as deep as the scene's entity count to avoid an
  // infinite loop if parentage is somehow malformed.
  private isAncestor(candidate: Entity): boolean {
    const scene = this.entity.scene;
    if (!scene) return false;
    let cursor: Entity | undefined = this.entity;
    let hops = 0;
    const max = scene.all().length + 1;
    while (cursor && hops <= max) {
      if (cursor.id === candidate.id) return true;
      const parentId: string | null = cursor.parentId;
      if (!parentId) return false;
      cursor = scene.getEntity(parentId);
      hops++;
    }
    return false;
  }
}

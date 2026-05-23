// Per-component property-schema types + aggregator (issue #1 of
// issues--property-schema-refactor.md). Each component class declares its own
// `static propertySchema` and `static label`; the aggregator walks an entity's
// components in topological order and returns one section per component that
// has a schema, filtered by `condition` and `hostOnly`.

import { type Entity } from './Entity';
import { type EntityComponent, type ComponentClass } from './EntityComponent';
import { componentRegistry } from './ComponentRegistry';

export type PropertyType =
  | 'number' | 'string' | 'color' | 'boolean' | 'seat'
  | 'tags'
  | 'asset:image' | 'asset:model' | 'asset:sound' | 'asset:pdf';

export interface PropertyDef<TState extends object = object> {
  key:        string;
  label:      string;
  type:       PropertyType;
  hostOnly?:  boolean;
  // Predicate over component state + owning entity. Returns false to hide.
  condition?: (state: TState, entity: Entity) => boolean;
  // Validation range. Flows into both UI input attributes and dispatcher
  // pre-clamping.
  min?:       number;
  max?:       number;
  // Adapter pair. When omitted, the row binds directly to `state[key]` on
  // read and `{ [key]: value }` on write.
  get?:       (state: TState, entity: Entity) => unknown;
  set?:       (value: unknown, state: TState, entity: Entity) => Partial<TState>;
}

export interface ComponentSchemaSection {
  typeId:  string;
  label:   string;
  // Filtered entries — `condition` false and `hostOnly` excluded for guests
  // are already stripped here.
  entries: PropertyDef[];
  // Component state at aggregation time, for the panel to read display values.
  state:   Record<string, unknown>;
}

export interface AggregateContext {
  isHost: boolean;
}

// Resolves the schema entries declared on a component class. Returns an empty
// array when the class hasn't declared one (no editable rows for that section).
export function getPropertySchema(cls: ComponentClass): readonly PropertyDef[] {
  const declared = (cls as { propertySchema?: readonly PropertyDef[] }).propertySchema;
  return declared ?? [];
}

// Resolves the human-readable label for a component class, falling back to
// the typeId when none is declared.
export function getComponentLabel(cls: ComponentClass): string {
  const declared = (cls as { label?: string }).label;
  return declared ?? cls.typeId;
}

// Walks the entity's components in topological onSpawn order and returns one
// section per component that declared a `propertySchema`. Sections are kept
// even when their entries list is empty after filtering — the panel uses that
// to render an "empty section" placeholder so the host can see what
// components are attached.
export function aggregatePropertySchema(
  entity: Entity,
  ctx: AggregateContext,
): ComponentSchemaSection[] {
  const typeIds = [...entity.components.keys()];
  if (typeIds.length === 0) return [];

  const ordered = componentRegistry.getSpawnOrder(typeIds);
  const sections: ComponentSchemaSection[] = [];

  for (const cls of ordered) {
    const schema = getPropertySchema(cls);
    if (schema.length === 0 && !(cls as { label?: string }).label) {
      // Component declares neither label nor schema — skip silently so it
      // doesn't surface as an empty section in the editor.
      continue;
    }
    const comp = entity.components.get(cls.typeId);
    if (!comp) continue;
    const state = comp.state as Record<string, unknown>;

    const entries: PropertyDef[] = [];
    for (const def of schema) {
      if (def.hostOnly && !ctx.isHost) continue;
      if (def.condition && !def.condition(state as object, entity)) continue;
      entries.push(def);
    }

    sections.push({
      typeId:  cls.typeId,
      label:   getComponentLabel(cls),
      entries,
      state:   { ...state },
    });
  }

  return sections;
}

// Reads the value for a schema entry — adapter `get` if present, otherwise
// `state[key]`. Used by the editor panel to bind row values.
export function readPropertyValue(
  def: PropertyDef,
  comp: EntityComponent<any>,
): unknown {
  const state = comp.state as Record<string, unknown>;
  if (def.get) return def.get(state as object, comp.entity);
  return state[def.key];
}

// Pre-clamps a numeric value against a schema range. Non-finite passes through
// unchanged so non-number types (string/color/etc.) are not coerced.
export function clampForSchema(def: PropertyDef, value: unknown): unknown {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  let v = value;
  if (typeof def.min === 'number' && v < def.min) v = def.min;
  if (typeof def.max === 'number' && v > def.max) v = def.max;
  return v;
}

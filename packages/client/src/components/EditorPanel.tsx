import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { type SpawnableType } from '../net/SceneState';
import { type ComponentSchemaSection, type PropertyDef } from '../entity/propertySchema';
import { getSpawnable } from '../entity/SpawnableRegistry';
import { SEAT_COLOURS } from '../seats/SeatLayout';
import { defaultSeatStates, normalizeYawDegrees, type SeatState } from '../seats/SeatPoseState';
import { type RoomStateSnapshot } from '../seats/RoomState';
import { TABLE_ENTITY_ID } from '../entity/tableEntity';
import { type ManifestStore } from '../assets/ManifestStore';
import { type AssetType } from '../assets/Manifest';
import { AssetPicker } from './AssetPicker';
import { assetService } from '../assets/AssetService';
import { BASE_MANIFEST, PRIMITIVE_MANIFEST } from '../assets/baseManifest';
import { type EditorToolItem } from '../entity/editorTools';
import { type SurfaceElement } from '../entity/components/SurfaceElement';
import { HtmlEditorModal } from './HtmlEditorModal';

export interface SurfaceSummary {
  canvasSize: [number, number];
  elements:   SurfaceElement[];
}

export interface ObjectSummary {
  id: string;
  objectType: SpawnableType;
  // Entity-level fields lifted to top-level for the Entity section.
  name:  string;
  owner: number | null;
  tags: string[];
  customData: Record<string, string>;
  // Aggregated schema sections — one per component that declares a
  // `propertySchema`. Each section carries its own state snapshot so the
  // panel doesn't need a live Entity reference.
  sections: ComponentSchemaSection[];
  parentId: string | null;
  // Populated when the entity carries a SurfaceComponent. Drives the
  // SurfaceElementsSection in the editor panel.
  surface?: SurfaceSummary | null;
}

interface Props {
  objects:              ObjectSummary[];
  // Multi-selection set. Single-entity callers can still pass a Set of one
  // (or none); the panel derives the size-1 soloId for the existing
  // property editor path. Size > 1 swaps to the GroupActionsSection.
  selectedIds:          ReadonlySet<string>;
  isFreeCamera:         boolean;
  manifestStore:        ManifestStore | null;
  selectedTools:        EditorToolItem[];
  // Current Table half-extents — used by the Seats section's "Reset all"
  // button to compute fresh defaults. Returns null when the Table has not
  // yet spawned.
  getTableBounds:       () => { halfWidth: number; halfDepth: number } | null;
  // Live room state — drives the Occupant column of the Seats section.
  roomSnapshot:         RoomStateSnapshot | null;
  // Index of the seat currently being edited via the 3D gizmo, or null
  // when no seat is in gizmo-edit mode. Drives the Edit / Done toggle in
  // the Seats section. Wired up by Issue #5.
  editingSeatIndex:     number | null;
  onSetEditingSeatIndex: (i: number | null) => void;
  onSelect:             (id: string | null) => void;
  onRollDice:           () => void;
  // Entity-level field write (name, tags, owner). Routes through
  // World.updateEntityField.
  onUpdateEntityField:  (id: string, key: string, value: unknown) => void;
  // Component-prop write. Routes through World.updateComponentProp.
  onUpdateComponentProp: (id: string, typeId: string, key: string, value: unknown) => void;
  onToggleFreeCamera:   (on: boolean) => void;
  // Fired for any interactive tool item — buttons (value undefined),
  // numerics (value: number), or booleans (value: boolean). Headings and
  // rows never call this.
  onToolAction:         (item: EditorToolItem, value?: unknown) => void;
  onMutateElement:      (surfaceId: string, elementId: string, patch: Record<string, unknown>) => void;
  onRemoveElement:      (surfaceId: string, elementId: string) => void;
  onDeleteEntity:       (id: string) => void;
  onDuplicateEntity:    (id: string) => void;
}

const PANEL: React.CSSProperties = {
  width:         280,
  background:    'var(--surface)',
  border:        '1px solid var(--line)',
  borderRadius:  'var(--panel-radius)',
  color:         'var(--ink)',
  fontFamily:    'var(--font-sans)',
  fontSize:      13,
  boxShadow:     'var(--shadow)',
  display:       'flex',
  flexDirection: 'column',
  maxHeight:     'calc(100vh - 24px)',
  minHeight:     0,
};

const HEADER: React.CSSProperties = {
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'space-between',
  padding:        '8px 12px',
  borderBottom:   '1px solid var(--line)',
  background:     'var(--surface-2)',
  cursor:         'pointer',
  userSelect:     'none',
  flexShrink:     0,
};

const BODY: React.CSSProperties = {
  flex:        '1 1 auto',
  minHeight:   0,
  overflowY:   'auto',
  overflowX:   'hidden',
};

const SECTION_HEADER: React.CSSProperties = {
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'space-between',
  cursor:         'pointer',
  userSelect:     'none',
  marginBottom:   6,
};

const SECTION: React.CSSProperties = {
  padding:      '10px 12px',
  borderBottom: '1px solid var(--line)',
};

const SECTION_LABEL: React.CSSProperties = {
  fontSize:      11,
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
  color:         'var(--ink-mute)',
  fontWeight:    700,
  marginBottom:  6,
};

const LIST_ROW: React.CSSProperties = {
  display:        'flex',
  justifyContent: 'space-between',
  padding:        '4px 8px',
  borderRadius:   4,
  cursor:         'pointer',
};

const SPAWN_BTN: React.CSSProperties = {
  background:   'var(--bg)',
  border:       '1px solid var(--line)',
  color:        'var(--ink)',
  padding:      '6px 10px',
  borderRadius: 'var(--card-radius)',
  cursor:       'pointer',
  fontFamily:   'inherit',
  fontSize:     12,
  fontWeight:   600,
  flex:         1,
};

const INPUT: React.CSSProperties = {
  width:        '100%',
  background:   'var(--bg)',
  border:       '1px solid var(--line)',
  color:        'var(--ink)',
  padding:      '4px 6px',
  borderRadius: 3,
  fontSize:     12,
  fontFamily:   'inherit',
  boxSizing:    'border-box',
};

const CHIP: React.CSSProperties = {
  display:      'inline-flex',
  alignItems:   'center',
  gap:          4,
  background:   'var(--surface-2)',
  color:        'var(--ink-2)',
  border:       '1px solid var(--line)',
  padding:      '2px 4px 2px 8px',
  borderRadius: 3,
  fontSize:     11,
};

const CHIP_X: React.CSSProperties = {
  background:   'none',
  border:       'none',
  color:        'var(--ink-mute)',
  cursor:       'pointer',
  fontSize:     14,
  lineHeight:   1,
  padding:      '0 2px',
};

export function EditorPanel({
  objects, selectedIds, isFreeCamera,
  manifestStore, selectedTools,
  getTableBounds, roomSnapshot,
  editingSeatIndex, onSetEditingSeatIndex,
  onSelect, onRollDice,
  onUpdateEntityField, onUpdateComponentProp,
  onToggleFreeCamera, onToolAction,
  onMutateElement, onRemoveElement,
  onDeleteEntity, onDuplicateEntity,
}: Props) {
  const [open, setOpen]           = useState(true);
  const [collapsed, setCollapsed] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{ ...PANEL, width: 'auto', padding: '6px 12px', cursor: 'pointer' }}
      >
        Open Editor
      </button>
    );
  }

  // soloId is the single-selection id (size === 1), used by the existing
  // per-entity sections. Multi-selection (size > 1) replaces those sections
  // with a GroupActionsSection — no per-entity property fields surface.
  const soloId = selectedIds.size === 1 ? selectedIds.values().next().value ?? null : null;
  const selected = soloId ? objects.find(o => o.id === soloId) ?? null : null;
  const isMulti  = selectedIds.size > 1;

  return (
    <div style={PANEL}>
      <div style={HEADER} onClick={() => setCollapsed(c => !c)}>
        <span style={{ fontWeight: 600 }}>Scene Editor {collapsed ? '▸' : '▾'}</span>
        <span>
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(false); }}
            style={{ background: 'none', border: 'none', color: 'var(--ink-mute)', cursor: 'pointer', fontSize: 16 }}
            title="Close"
          >×</button>
        </span>
      </div>

      {!collapsed && (
        <div style={BODY}>
          <SceneGraphList objects={objects} selectedIds={selectedIds} onSelect={onSelect} />
          {isMulti ? (
            <GroupActionsSection size={selectedIds.size} />
          ) : (
            <>
              <PropertyEditor
                selected={selected}
                manifestStore={manifestStore}
                onUpdateEntityField={onUpdateEntityField}
                onUpdateComponentProp={onUpdateComponentProp}
                onDeleteEntity={onDeleteEntity}
                onDuplicateEntity={onDuplicateEntity}
              />
              {selected?.id === TABLE_ENTITY_ID && (
                <SeatsSection
                  table={selected}
                  roomSnapshot={roomSnapshot}
                  getTableBounds={getTableBounds}
                  editingSeatIndex={editingSeatIndex}
                  onSetEditingSeatIndex={onSetEditingSeatIndex}
                  onUpdateComponentProp={onUpdateComponentProp}
                />
              )}
              {selected?.surface && (
                <SurfaceElementsSection
                  surfaceId={selected.id}
                  surface={selected.surface}
                  manifestStore={manifestStore}
                  onMutateElement={onMutateElement}
                  onRemoveElement={onRemoveElement}
                />
              )}
              <ToolsSection tools={selected ? selectedTools : []} onToolAction={onToolAction} />
            </>
          )}
          <RollSection onRollDice={onRollDice} />
          <CameraSection isFreeCamera={isFreeCamera} onToggleFreeCamera={onToggleFreeCamera} />
        </div>
      )}
    </div>
  );
}

// Multi-selection panel: header showing "<N> selected" plus group action
// buttons. Fan-out wiring lands in slice #4; for now the buttons are inert.
function GroupActionsSection({ size }: { size: number }) {
  const labelStyle: React.CSSProperties = {
    ...SECTION_LABEL,
    marginBottom: 8,
  };
  const buttonRow: React.CSSProperties = {
    display:             'grid',
    gridTemplateColumns: '1fr 1fr',
    gap:                 6,
  };
  return (
    <div style={SECTION}>
      <div style={labelStyle}>{size} selected</div>
      <div style={buttonRow}>
        <button
          type="button"
          style={{ ...SPAWN_BTN, cursor: 'not-allowed', opacity: 0.5 }}
          disabled
          title="Group flip — coming in slice #4"
        >Flip</button>
        <button
          type="button"
          style={{ ...SPAWN_BTN, cursor: 'not-allowed', opacity: 0.5 }}
          disabled
          title="Group rotate — coming in slice #6"
        >Rotate</button>
        <button
          type="button"
          style={{ ...SPAWN_BTN, cursor: 'not-allowed', opacity: 0.5 }}
          disabled
          title="Group delete — coming in slice #4"
        >Delete</button>
        <button
          type="button"
          style={{ ...SPAWN_BTN, cursor: 'not-allowed', opacity: 0.5 }}
          disabled
          title="Group duplicate — coming in slice #7"
        >Duplicate</button>
      </div>
    </div>
  );
}

function SceneGraphList({
  objects, selectedIds, onSelect,
}: { objects: ObjectSummary[]; selectedIds: ReadonlySet<string>; onSelect: (id: string | null) => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const byId      = new Map(objects.map(o => [o.id, o]));
  const childrenOf = new Map<string | null, ObjectSummary[]>();
  for (const o of objects) {
    const p = o.parentId && byId.has(o.parentId) ? o.parentId : null;
    const arr = childrenOf.get(p) ?? [];
    arr.push(o);
    childrenOf.set(p, arr);
  }
  // Pin the Table row at the top of the root list regardless of input order.
  const rawRoots = childrenOf.get(null) ?? [];
  const roots = [
    ...rawRoots.filter(o => o.id === TABLE_ENTITY_ID),
    ...rawRoots.filter(o => o.id !== TABLE_ENTITY_ID),
  ];

  return (
    <div style={SECTION}>
      <div style={SECTION_LABEL}>Objects ({objects.length})</div>
      {objects.length === 0 && <div style={{ color: 'var(--ink-mute)', fontSize: 12 }}>No objects yet</div>}
      {roots.map(o => (
        <SceneGraphNode
          key={o.id}
          node={o}
          depth={0}
          childrenOf={childrenOf}
          expanded={expanded}
          selectedIds={selectedIds}
          onToggle={toggle}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function SceneGraphNode({
  node, depth, childrenOf, expanded, selectedIds, onToggle, onSelect,
}: {
  node:        ObjectSummary;
  depth:       number;
  childrenOf:  Map<string | null, ObjectSummary[]>;
  expanded:    Set<string>;
  selectedIds: ReadonlySet<string>;
  onToggle:    (id: string) => void;
  onSelect:    (id: string | null) => void;
}) {
  const kids   = childrenOf.get(node.id) ?? [];
  const hasKids = kids.length > 0;
  const isOpen = expanded.has(node.id);
  const isSel  = selectedIds.has(node.id);

  return (
    <>
      <div
        style={{
          ...LIST_ROW,
          paddingLeft: 8 + depth * 12,
          background:  isSel ? 'color-mix(in oklab, var(--accent) 22%, transparent)' : 'transparent',
        }}
        onClick={() => onSelect(isSel ? null : node.id)}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
          <span
            onClick={e => { e.stopPropagation(); if (hasKids) onToggle(node.id); }}
            style={{
              display:        'inline-flex',
              alignItems:     'center',
              justifyContent: 'center',
              width:          22,
              height:         22,
              marginLeft:     -4,
              color:          'var(--ink-mute)',
              cursor:         hasKids ? 'pointer' : 'default',
              fontSize:       16,
              lineHeight:     1,
              userSelect:     'none',
            }}
          >
            {hasKids ? (isOpen ? '▾' : '▸') : ''}
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.id}</span>
        </span>
        <span style={{ color: 'var(--ink-mute)', flexShrink: 0, marginLeft: 6 }}>{getSpawnable(node.objectType)?.label ?? node.objectType}</span>
      </div>
      {hasKids && isOpen && kids.map(k => (
        <SceneGraphNode
          key={k.id}
          node={k}
          depth={depth + 1}
          childrenOf={childrenOf}
          expanded={expanded}
          selectedIds={selectedIds}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

function PropertyEditor({
  selected, manifestStore,
  onUpdateEntityField, onUpdateComponentProp, onDeleteEntity, onDuplicateEntity,
}: {
  selected:              ObjectSummary | null;
  manifestStore:         ManifestStore | null;
  onUpdateEntityField:   (id: string, key: string, value: unknown) => void;
  onUpdateComponentProp: (id: string, typeId: string, key: string, value: unknown) => void;
  onDeleteEntity:        (id: string) => void;
  onDuplicateEntity:     (id: string) => void;
}) {
  if (!selected) {
    return (
      <div style={SECTION}>
        <div style={SECTION_LABEL}>Properties</div>
        <div style={{ color: 'var(--ink-mute)', fontSize: 12 }}>Select an object to edit its properties</div>
      </div>
    );
  }

  return (
    <>
      <EntitySection
        selected={selected}
        onUpdateEntityField={onUpdateEntityField}
        onDeleteEntity={onDeleteEntity}
        onDuplicateEntity={onDuplicateEntity}
      />
      {selected.sections.map(section => (
        <ComponentSection
          key={section.typeId}
          entityId={selected.id}
          section={section}
          manifestStore={manifestStore}
          onUpdateComponentProp={onUpdateComponentProp}
        />
      ))}
    </>
  );
}

function EntitySection({
  selected, onUpdateEntityField, onDeleteEntity, onDuplicateEntity,
}: {
  selected:            ObjectSummary;
  onUpdateEntityField: (id: string, key: string, value: unknown) => void;
  onDeleteEntity:      (id: string) => void;
  onDuplicateEntity:   (id: string) => void;
}) {
  const isTable = selected.id === TABLE_ENTITY_ID;
  return (
    <div style={SECTION}>
      <div style={SECTION_LABEL}>Entity — {selected.id}</div>
      <div style={{ marginBottom: 8 }}>
        <label style={{ display: 'block', color: 'var(--ink-mute)', fontSize: 11, marginBottom: 3 }}>Name</label>
        <input
          type="text"
          style={INPUT}
          value={selected.name}
          onChange={e => onUpdateEntityField(selected.id, 'name', e.target.value)}
        />
      </div>
      <div style={{ marginBottom: 8 }}>
        <label style={{ display: 'block', color: 'var(--ink-mute)', fontSize: 11, marginBottom: 3 }}>Owner</label>
        <SeatSelect
          value={selected.owner ?? -1}
          onChange={(v) => onUpdateEntityField(selected.id, 'owner', v)}
        />
      </div>
      <TagsRow
        tags={selected.tags}
        onChange={(next) => onUpdateEntityField(selected.id, 'tags', next)}
      />
      <CustomDataRow
        customData={selected.customData}
        onChange={(next) => onUpdateEntityField(selected.id, 'customData', next)}
      />
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button
          type="button"
          style={{
            ...SPAWN_BTN,
            background:   isTable ? 'var(--surface-2)' : 'var(--bg)',
            borderColor:  'var(--line)',
            color:        isTable ? 'var(--ink-mute)' : 'var(--ink)',
            cursor:       isTable ? 'not-allowed' : 'pointer',
          }}
          disabled={isTable}
          title={isTable ? 'The Table cannot be duplicated' : 'Duplicate this entity'}
          onClick={() => onDuplicateEntity(selected.id)}
        >
          Duplicate
        </button>
        <button
          type="button"
          style={{
            ...SPAWN_BTN,
            background:   isTable ? 'var(--surface-2)' : 'color-mix(in oklab, var(--accent) 22%, transparent)',
            borderColor:  isTable ? 'var(--line)' : 'color-mix(in oklab, var(--accent) 45%, transparent)',
            color:        isTable ? 'var(--ink-mute)' : 'var(--accent-deep)',
            cursor:       isTable ? 'not-allowed' : 'pointer',
          }}
          disabled={isTable}
          title={isTable ? 'The Table cannot be deleted' : 'Delete this entity'}
          onClick={() => onDeleteEntity(selected.id)}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function ComponentSection({
  entityId, section, manifestStore, onUpdateComponentProp,
}: {
  entityId:              string;
  section:               ComponentSchemaSection;
  manifestStore:         ManifestStore | null;
  onUpdateComponentProp: (id: string, typeId: string, key: string, value: unknown) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div style={SECTION}>
      <div style={SECTION_HEADER} onClick={() => setCollapsed(c => !c)}>
        <div style={{ ...SECTION_LABEL, marginBottom: 0 }}>{section.label}</div>
        <span style={{ color: 'var(--ink-mute)', fontSize: 11, lineHeight: 1 }}>{collapsed ? '▸' : '▾'}</span>
      </div>
      {!collapsed && (
        <>
          {section.entries.length === 0 && (
            <div style={{ color: 'var(--ink-mute)', fontSize: 12 }}>No editable properties.</div>
          )}
          {section.entries.map(def => (
            <SchemaPropertyRow
              key={def.key}
              def={def}
              value={readEntryValue(def, section.state)}
              manifestStore={manifestStore}
              onChange={(v) => onUpdateComponentProp(entityId, section.typeId, def.key, v)}
            />
          ))}
        </>
      )}
    </div>
  );
}

function readEntryValue(def: PropertyDef, state: Record<string, unknown>): unknown {
  if (def.get) return def.get(state as object, undefined as never);
  return state[def.key];
}

function TagsRow({
  tags, onChange,
}: { tags: string[]; onChange: (next: string[]) => void }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <label style={{ display: 'block', color: 'var(--ink-mute)', fontSize: 11, marginBottom: 3 }}>Tags</label>
      <TagsEditor tags={tags} onChange={onChange} />
    </div>
  );
}

function TagsEditor({
  tags, onChange,
}: { tags: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState('');

  const commit = () => {
    const t = draft.trim().toLowerCase();
    setDraft('');
    if (!t || tags.includes(t)) return;
    onChange([...tags, t]);
  };
  const remove = (t: string) => onChange(tags.filter(x => x !== t));

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
        {tags.map(t => (
          <span key={t} style={CHIP}>
            {t}
            <button
              onClick={() => remove(t)}
              style={CHIP_X}
              title="Remove tag"
            >×</button>
          </span>
        ))}
      </div>
      <input
        type="text"
        style={INPUT}
        placeholder="Add tag…"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
          else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
            remove(tags[tags.length - 1]);
          }
        }}
        onBlur={commit}
      />
    </>
  );
}

function CustomDataRow({
  customData, onChange,
}: { customData: Record<string, string>; onChange: (next: Record<string, string>) => void }) {
  const [draftKey, setDraftKey] = useState('');
  const [draftValue, setDraftValue] = useState('');
  const entries = Object.entries(customData);

  const renameKey = (oldKey: string, newKey: string) => {
    const k = newKey.trim();
    if (!k || k === oldKey) return;
    const next: Record<string, string> = {};
    for (const [ek, ev] of entries) {
      if (ek === oldKey) next[k] = ev;
      else if (ek !== k) next[ek] = ev;
    }
    onChange(next);
  };

  const setValue = (key: string, value: string) => {
    if (customData[key] === value) return;
    onChange({ ...customData, [key]: value });
  };

  const remove = (key: string) => {
    const next: Record<string, string> = {};
    for (const [ek, ev] of entries) if (ek !== key) next[ek] = ev;
    onChange(next);
  };

  const addDraft = () => {
    const k = draftKey.trim();
    if (!k) return;
    onChange({ ...customData, [k]: draftValue });
    setDraftKey('');
    setDraftValue('');
  };

  return (
    <div style={{ marginBottom: 8 }}>
      <label style={{ display: 'block', color: 'var(--ink-mute)', fontSize: 11, marginBottom: 3 }}>Custom Data</label>
      {entries.map(([k, v]) => (
        <CustomDataEntry
          key={k}
          entryKey={k}
          entryValue={v}
          onRenameKey={(nk) => renameKey(k, nk)}
          onChangeValue={(nv) => setValue(k, nv)}
          onRemove={() => remove(k)}
        />
      ))}
      <div style={CUSTOM_DATA_ROW}>
        <input
          type="text"
          style={INPUT}
          placeholder="key"
          value={draftKey}
          onChange={e => setDraftKey(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDraft(); } }}
        />
        <input
          type="text"
          style={INPUT}
          placeholder="value"
          value={draftValue}
          onChange={e => setDraftValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDraft(); } }}
        />
        <button
          type="button"
          style={CUSTOM_DATA_ADD_BTN}
          onClick={addDraft}
          disabled={!draftKey.trim()}
          title="Add entry"
        >+</button>
      </div>
    </div>
  );
}

function CustomDataEntry({
  entryKey, entryValue, onRenameKey, onChangeValue, onRemove,
}: {
  entryKey:      string;
  entryValue:    string;
  onRenameKey:   (next: string) => void;
  onChangeValue: (next: string) => void;
  onRemove:      () => void;
}) {
  const [keyDraft, setKeyDraft] = useState(entryKey);
  const [valDraft, setValDraft] = useState(entryValue);
  useEffect(() => { setKeyDraft(entryKey); }, [entryKey]);
  useEffect(() => { setValDraft(entryValue); }, [entryValue]);

  return (
    <div style={CUSTOM_DATA_ROW}>
      <input
        type="text"
        style={INPUT}
        value={keyDraft}
        onChange={e => setKeyDraft(e.target.value)}
        onBlur={() => onRenameKey(keyDraft)}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
      <input
        type="text"
        style={INPUT}
        value={valDraft}
        onChange={e => setValDraft(e.target.value)}
        onBlur={() => onChangeValue(valDraft)}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
      <button
        type="button"
        style={CHIP_X}
        onClick={onRemove}
        title="Remove entry"
      >×</button>
    </div>
  );
}

const CUSTOM_DATA_ROW: React.CSSProperties = {
  display:             'grid',
  gridTemplateColumns: '1fr 1fr auto',
  gap:                 4,
  marginBottom:        4,
  alignItems:          'center',
};

const CUSTOM_DATA_ADD_BTN: React.CSSProperties = {
  background:   'var(--bg)',
  border:       '1px solid var(--line)',
  color:        'var(--ink)',
  cursor:       'pointer',
  fontSize:     14,
  lineHeight:   1,
  padding:      '2px 8px',
  borderRadius: 3,
};

function SchemaPropertyRow({
  def, value, manifestStore, onChange,
}: {
  def:           PropertyDef;
  value:         unknown;
  manifestStore: ManifestStore | null;
  onChange:      (v: unknown) => void;
}) {
  const isAsset = def.type === 'asset:image' || def.type === 'asset:model' || def.type === 'asset:sound' || def.type === 'asset:pdf';
  const assetType: AssetType | null = isAsset
    ? (def.type.slice('asset:'.length) as AssetType)
    : null;
  return (
    <div style={{ marginBottom: 8 }}>
      <label style={{ display: 'block', color: 'var(--ink-mute)', fontSize: 11, marginBottom: 3 }}>{def.label}</label>
      {def.type === 'number' && (
        <input
          type="number"
          step="0.1"
          min={def.min}
          max={def.max}
          style={INPUT}
          value={(value as number) ?? 0}
          onChange={e => onChange(parseFloat(e.target.value) || 0)}
        />
      )}
      {def.type === 'string' && (
        <input
          type="text"
          style={INPUT}
          value={(value as string) ?? ''}
          onChange={e => onChange(e.target.value)}
        />
      )}
      {def.type === 'color' && (
        <input
          type="color"
          style={{ ...INPUT, padding: 2, height: 28 }}
          value={(value as string) ?? '#ffffff'}
          onChange={e => onChange(e.target.value)}
        />
      )}
      {def.type === 'boolean' && (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={e => onChange(e.target.checked)}
        />
      )}
      {def.type === 'seat' && (
        <SeatSelect value={value as number} onChange={onChange} />
      )}
      {def.type === 'tags' && (
        <TagsEditor
          tags={Array.isArray(value) ? (value as string[]) : []}
          onChange={(next) => onChange(next)}
        />
      )}
      {assetType && (
        <AssetField
          assetType={assetType}
          value={(value as string) ?? ''}
          manifestStore={manifestStore}
          onChange={(v) => onChange(v)}
        />
      )}
    </div>
  );
}

const ASSET_ROW: React.CSSProperties = {
  display:      'flex',
  alignItems:   'center',
  gap:          6,
  background:   'var(--bg)',
  border:       '1px solid var(--line)',
  borderRadius: 3,
  padding:      4,
  cursor:       'pointer',
  minHeight:    32,
  boxSizing:    'border-box',
};

const ASSET_THUMB: React.CSSProperties = {
  width:           28,
  height:          28,
  flex:            '0 0 auto',
  background:      'var(--surface-2)',
  border:          '1px solid var(--line)',
  borderRadius:    2,
  display:         'flex',
  alignItems:      'center',
  justifyContent:  'center',
  fontSize:        9,
  color:           'var(--ink-mute)',
  textTransform:   'uppercase',
  overflow:        'hidden',
};

const ASSET_THUMB_IMG: React.CSSProperties = {
  width:    '100%',
  height:   '100%',
  objectFit: 'cover',
};

const ASSET_LABEL: React.CSSProperties = {
  flex:         1,
  fontSize:     12,
  color:        'var(--ink)',
  whiteSpace:   'nowrap',
  overflow:     'hidden',
  textOverflow: 'ellipsis',
  minWidth:     0,
};

const ASSET_BTN: React.CSSProperties = {
  background:   'none',
  border:       'none',
  color:        'var(--ink-mute)',
  cursor:       'pointer',
  fontSize:     14,
  padding:      '0 4px',
  flex:         '0 0 auto',
};

function AssetField({
  assetType, value, manifestStore, onChange,
}: {
  assetType:     AssetType;
  value:         string;
  manifestStore: ManifestStore | null;
  onChange:      (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = value || '';
  const display = describeRef(ref, manifestStore);

  return (
    <>
      <div
        style={ASSET_ROW}
        onClick={() => setOpen(true)}
        title={ref || 'No asset selected'}
      >
        <AssetThumbnail assetType={assetType} ref_={ref} />
        <span style={ASSET_LABEL}>{display}</span>
        <span style={{ color: 'var(--ink-mute)', flex: '0 0 auto' }}>▼</span>
        {ref && (
          <button
            type="button"
            style={ASSET_BTN}
            title="Clear"
            onClick={(e) => { e.stopPropagation(); onChange(''); }}
          >×</button>
        )}
      </div>
      <AssetPicker
        open={open}
        onClose={() => setOpen(false)}
        onSelect={(v) => onChange(v)}
        type={assetType}
        store={manifestStore}
        currentRef={ref || undefined}
      />
    </>
  );
}

function describeRef(ref: string, store: ManifestStore | null): string {
  if (!ref) return 'No asset';
  if (ref.includes(':') && !/^https?:|^data:|^blob:/i.test(ref)) {
    const entry = store?.getDraft().get(ref)
      ?? PRIMITIVE_MANIFEST.get(ref)
      ?? BASE_MANIFEST.get(ref);
    if (entry) return entry.name;
    return ref;
  }
  return shortUrl(ref);
}

function shortUrl(url: string): string {
  if (url.length <= 40) return url;
  const idx = url.lastIndexOf('/');
  const tail = idx >= 0 ? url.slice(idx + 1) : url;
  return tail.length > 0 ? '…/' + tail : url;
}

function AssetThumbnail({ assetType, ref_ }: { assetType: AssetType; ref_: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    setSrc(null);
    if (!ref_ || assetType !== 'image') return;
    const unsub = assetService.subscribe(ref_, 'image', (tex, status) => {
      if (status !== 'loaded') { setSrc(null); return; }
      setSrc(textureToDataUrl(tex));
    });
    return unsub;
  }, [ref_, assetType]);

  if (assetType === 'image' && src) {
    return (
      <div style={ASSET_THUMB}>
        <img src={src} alt="" style={ASSET_THUMB_IMG} />
      </div>
    );
  }
  return <div style={ASSET_THUMB}>{assetType[0]}</div>;
}

// Snapshot a Three texture into an <img>-friendly data URL by drawing the
// underlying image to a small canvas. Returns null on environments without a
// usable image (e.g. tests with the magenta placeholder DataTexture).
function textureToDataUrl(tex: THREE.Texture): string | null {
  if (typeof document === 'undefined') return null;
  const img = (tex as { image?: unknown }).image;
  if (!img) return null;
  const w = (img as { width?: number }).width  ?? 0;
  const h = (img as { height?: number }).height ?? 0;
  if (!w || !h) return null;
  try {
    const canvas = document.createElement('canvas');
    const SIZE = 64;
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img as CanvasImageSource, 0, 0, SIZE, SIZE);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

function SeatSelect({ value, onChange }: { value: number | undefined; onChange: (v: unknown) => void }) {
  const current = typeof value === 'number' ? value : -1;
  const swatch = current >= 0 && current < SEAT_COLOURS.length ? SEAT_COLOURS[current] : 'transparent';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        width: 14, height: 14, borderRadius: 3,
        background: swatch,
        border: '1px solid var(--line-strong)',
        flex: '0 0 auto',
      }} />
      <select
        style={INPUT}
        value={current}
        onChange={e => onChange(parseInt(e.target.value, 10))}
      >
        <option value={-1}>None</option>
        {SEAT_COLOURS.map((c, i) => (
          <option key={i} value={i} style={{ background: c, color: '#000' }}>
            Seat {i} — {c}
          </option>
        ))}
      </select>
    </div>
  );
}

function ToolsSection({
  tools, onToolAction,
}: {
  tools:        EditorToolItem[];
  onToolAction: (item: EditorToolItem, value?: unknown) => void;
}) {
  if (tools.length === 0) return null;
  return (
    <div style={SECTION}>
      <div style={SECTION_LABEL}>Tools</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {tools.map((item, i) => (
          <ToolItemView
            key={toolItemKey(item, i)}
            item={item}
            firstInList={i === 0}
            onToolAction={onToolAction}
          />
        ))}
      </div>
    </div>
  );
}

function ToolItemView({
  item, firstInList, onToolAction,
}: {
  item:         EditorToolItem;
  firstInList:  boolean;
  onToolAction: (item: EditorToolItem, value?: unknown) => void;
}) {
  if (item.kind === 'heading') {
    return (
      <div style={{ ...SECTION_LABEL, marginBottom: 0, marginTop: firstInList ? 0 : 4 }}>
        {item.label}
      </div>
    );
  }
  if (item.kind === 'row') {
    return (
      <div style={TOOL_ROW}>
        {item.items.map((sub, j) => (
          <ToolItemView
            key={toolItemKey(sub, j)}
            item={sub}
            firstInList={false}
            onToolAction={onToolAction}
          />
        ))}
      </div>
    );
  }
  if (item.kind === 'button') {
    return (
      <button
        style={SPAWN_BTN}
        disabled={item.disabled}
        onClick={() => onToolAction(item)}
      >{item.label}</button>
    );
  }
  if (item.kind === 'number') {
    return (
      <label style={TOOL_FIELD}>
        {item.label && <span style={TOOL_FIELD_LABEL}>{item.label}</span>}
        <input
          type="number"
          step={item.step ?? 0.1}
          min={item.min}
          max={item.max}
          style={TOOL_INPUT}
          value={Number.isFinite(item.value) ? item.value : 0}
          onChange={(e) => {
            const n = parseFloat(e.target.value);
            onToolAction(item, Number.isFinite(n) ? n : 0);
          }}
        />
      </label>
    );
  }
  // boolean
  return (
    <label style={TOOL_FIELD}>
      {item.label && <span style={TOOL_FIELD_LABEL}>{item.label}</span>}
      <input
        type="checkbox"
        checked={Boolean(item.value)}
        onChange={(e) => onToolAction(item, e.target.checked)}
      />
    </label>
  );
}

function toolItemKey(item: EditorToolItem, idx: number): string {
  if (item.kind === 'heading') return `h-${idx}-${item.label}`;
  if (item.kind === 'row')     return `row-${idx}`;
  const argSuffix = item.args ? JSON.stringify(item.args) : '';
  return `${item.componentTypeId ?? ''}:${item.id}:${argSuffix}`;
}

const TOOL_ROW: React.CSSProperties = {
  display:    'flex',
  alignItems: 'flex-end',
  flexWrap:   'wrap',
  gap:        4,
};

const TOOL_FIELD: React.CSSProperties = {
  display:       'flex',
  flexDirection: 'column',
  alignItems:    'stretch',
  gap:           2,
  flex:          '1 1 36px',
  minWidth:      0,
};

const TOOL_FIELD_LABEL: React.CSSProperties = {
  color:    'var(--ink-mute)',
  fontSize: 10,
};

const TOOL_INPUT: React.CSSProperties = {
  width:        '100%',
  background:   'var(--bg)',
  border:       '1px solid var(--line)',
  color:        'var(--ink)',
  padding:      '3px 4px',
  borderRadius: 3,
  fontSize:     11,
  fontFamily:   'inherit',
  boxSizing:    'border-box',
  minWidth:     0,
};

function RollSection({ onRollDice }: { onRollDice: () => void }) {
  return (
    <div style={SECTION}>
      <div style={SECTION_LABEL}>Dice</div>
      <button
        style={{ ...SPAWN_BTN, borderColor: 'color-mix(in oklab, var(--gold) 50%, transparent)', color: 'var(--gold)', width: '100%' }}
        onClick={onRollDice}
      >
        Roll All Dice
      </button>
    </div>
  );
}

function CameraSection({
  isFreeCamera, onToggleFreeCamera,
}: { isFreeCamera: boolean; onToggleFreeCamera: (on: boolean) => void }) {
  return (
    <div style={{ ...SECTION, borderBottom: 'none' }}>
      <div style={SECTION_LABEL}>Camera</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={isFreeCamera}
          onChange={e => onToggleFreeCamera(e.target.checked)}
        />
        Unrestricted camera (no floor constraint)
      </label>
    </div>
  );
}

// ── Surface Elements ────────────────────────────────────────────────────────

const ELEMENT_CARD: React.CSSProperties = {
  background:   'var(--surface-2)',
  border:       '1px solid var(--line)',
  borderRadius: 4,
  padding:      8,
  marginBottom: 6,
};

const ELEMENT_HEADER: React.CSSProperties = {
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'space-between',
  marginBottom:   6,
};

const KIND_BADGE: React.CSSProperties = {
  fontSize:      10,
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
  fontWeight:    700,
  background:    'color-mix(in oklab, var(--accent) 18%, transparent)',
  color:         'var(--accent-deep)',
  border:        '1px solid color-mix(in oklab, var(--accent) 30%, transparent)',
  padding:       '2px 6px',
  borderRadius:  3,
};

const PAIR_ROW: React.CSSProperties = {
  display:       'grid',
  gridTemplateColumns: '1fr 1fr',
  gap:           6,
  marginBottom:  6,
};

const PAIR_LABEL: React.CSSProperties = {
  display:    'block',
  color:      'var(--ink-mute)',
  fontSize:   11,
  marginBottom: 3,
};

const HTML_PREVIEW: React.CSSProperties = {
  background:   'var(--bg)',
  border:       '1px solid var(--line)',
  borderRadius: 3,
  padding:      6,
  fontSize:     11,
  fontFamily:   'var(--font-mono)',
  color:        'var(--ink-2)',
  whiteSpace:   'nowrap',
  overflow:     'hidden',
  textOverflow: 'ellipsis',
  marginBottom: 6,
};

function SurfaceElementsSection({
  surfaceId, surface, manifestStore, onMutateElement, onRemoveElement,
}: {
  surfaceId:       string;
  surface:         SurfaceSummary;
  manifestStore:   ManifestStore | null;
  onMutateElement: (surfaceId: string, elementId: string, patch: Record<string, unknown>) => void;
  onRemoveElement: (surfaceId: string, elementId: string) => void;
}) {
  return (
    <div style={SECTION}>
      <div style={SECTION_LABEL}>Surface Elements ({surface.elements.length})</div>
      {surface.elements.length === 0 && (
        <div style={{ color: 'var(--ink-mute)', fontSize: 12 }}>
          Use the Tools section below to add Rich UI / Image / Shape / Button elements.
        </div>
      )}
      {surface.elements.map((el) => (
        <SurfaceElementCard
          key={el.id}
          surfaceId={surfaceId}
          element={el}
          manifestStore={manifestStore}
          onMutate={(patch) => onMutateElement(surfaceId, el.id, patch)}
          onRemove={() => onRemoveElement(surfaceId, el.id)}
        />
      ))}
    </div>
  );
}

function SurfaceElementCard({
  surfaceId, element, manifestStore, onMutate, onRemove,
}: {
  surfaceId:     string;
  element:       SurfaceElement;
  manifestStore: ManifestStore | null;
  onMutate:      (patch: Record<string, unknown>) => void;
  onRemove:      () => void;
}) {
  void surfaceId;
  return (
    <div style={ELEMENT_CARD}>
      <div style={ELEMENT_HEADER}>
        <span style={KIND_BADGE}>{element.kind}</span>
        <span style={{ color: 'var(--ink-mute)', fontSize: 10, fontFamily: 'var(--font-mono)', flex: 1, marginLeft: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {element.id.slice(0, 8)}
        </span>
        <button
          onClick={onRemove}
          style={{ ...CHIP_X, fontSize: 16 }}
          title="Remove element"
        >×</button>
      </div>

      <div style={PAIR_ROW}>
        <div>
          <label style={PAIR_LABEL}>X</label>
          <input
            type="number"
            step="1"
            style={INPUT}
            value={element.x}
            onChange={e => onMutate({ x: numberOr(e.target.value, 0) })}
          />
        </div>
        <div>
          <label style={PAIR_LABEL}>Y</label>
          <input
            type="number"
            step="1"
            style={INPUT}
            value={element.y}
            onChange={e => onMutate({ y: numberOr(e.target.value, 0) })}
          />
        </div>
      </div>

      <div style={PAIR_ROW}>
        <div>
          <label style={PAIR_LABEL}>Width</label>
          <input
            type="number"
            step="1"
            min="0"
            style={INPUT}
            value={element.w}
            onChange={e => onMutate({ w: numberOr(e.target.value, 0) })}
          />
        </div>
        <div>
          <label style={PAIR_LABEL}>Height</label>
          <input
            type="number"
            step="1"
            min="0"
            style={INPUT}
            value={element.h}
            onChange={e => onMutate({ h: numberOr(e.target.value, 0) })}
          />
        </div>
      </div>

      {element.kind === 'shape' && (
        <ShapeKindRow element={element} onMutate={onMutate} />
      )}
      {element.kind === 'image' && (
        <ImageKindRow element={element} manifestStore={manifestStore} onMutate={onMutate} />
      )}
      {element.kind === 'rich' && (
        <RichKindRow element={element} onMutate={onMutate} />
      )}
      {element.kind === 'button' && (
        <ButtonKindRow element={element} manifestStore={manifestStore} onMutate={onMutate} />
      )}
    </div>
  );
}

function ShapeKindRow({
  element, onMutate,
}: {
  element:  SurfaceElement & { kind: 'shape' };
  onMutate: (patch: Record<string, unknown>) => void;
}) {
  return (
    <>
      <div style={{ marginBottom: 6 }}>
        <label style={PAIR_LABEL}>Shape</label>
        <select
          style={INPUT}
          value={element.shape}
          onChange={e => onMutate({ shape: e.target.value as 'rect' | 'circle' })}
        >
          <option value="rect">Rectangle</option>
          <option value="circle">Circle</option>
        </select>
      </div>
      <div style={PAIR_ROW}>
        <div>
          <label style={PAIR_LABEL}>Fill</label>
          <input
            type="color"
            style={{ ...INPUT, padding: 2, height: 28 }}
            value={element.fill ?? '#88c0ff'}
            onChange={e => onMutate({ fill: e.target.value })}
          />
        </div>
        <div>
          <label style={PAIR_LABEL}>Stroke</label>
          <input
            type="color"
            style={{ ...INPUT, padding: 2, height: 28 }}
            value={element.stroke ?? '#000000'}
            onChange={e => onMutate({ stroke: e.target.value })}
          />
        </div>
      </div>
      <div style={PAIR_ROW}>
        <div>
          <label style={PAIR_LABEL}>Stroke W</label>
          <input
            type="number"
            min="0"
            step="0.5"
            style={INPUT}
            value={element.strokeWidth ?? 0}
            onChange={e => onMutate({ strokeWidth: numberOr(e.target.value, 0) })}
          />
        </div>
        {element.shape === 'rect' && (
          <div>
            <label style={PAIR_LABEL}>Radius</label>
            <input
              type="number"
              min="0"
              step="1"
              style={INPUT}
              value={element.radius ?? 0}
              onChange={e => onMutate({ radius: numberOr(e.target.value, 0) })}
            />
          </div>
        )}
      </div>
    </>
  );
}

function ImageKindRow({
  element, manifestStore, onMutate,
}: {
  element:       SurfaceElement & { kind: 'image' };
  manifestStore: ManifestStore | null;
  onMutate:      (patch: Record<string, unknown>) => void;
}) {
  return (
    <>
      <div style={{ marginBottom: 6 }}>
        <label style={PAIR_LABEL}>Image</label>
        <AssetField
          assetType="image"
          value={element.textureRef}
          manifestStore={manifestStore}
          onChange={(v) => onMutate({ textureRef: v })}
        />
      </div>
      <div style={{ marginBottom: 0 }}>
        <label style={PAIR_LABEL}>Fit</label>
        <select
          style={INPUT}
          value={element.fit}
          onChange={e => onMutate({ fit: e.target.value })}
        >
          <option value="fit">Fit (letterbox)</option>
          <option value="cover">Cover (crop)</option>
          <option value="stretch">Stretch</option>
          <option value="none">None (native size)</option>
        </select>
      </div>
    </>
  );
}

function ButtonKindRow({
  element, manifestStore, onMutate,
}: {
  element:       SurfaceElement & { kind: 'button' };
  manifestStore: ManifestStore | null;
  onMutate:      (patch: Record<string, unknown>) => void;
}) {
  return (
    <>
      <div style={{ marginBottom: 6 }}>
        <label style={PAIR_LABEL}>Normal</label>
        <AssetField
          assetType="image"
          value={element.normalRef}
          manifestStore={manifestStore}
          onChange={(v) => onMutate({ normalRef: v })}
        />
      </div>
      <div style={{ marginBottom: 6 }}>
        <label style={PAIR_LABEL}>Hovered</label>
        <AssetField
          assetType="image"
          value={element.hoveredRef ?? ''}
          manifestStore={manifestStore}
          onChange={(v) => onMutate({ hoveredRef: v })}
        />
      </div>
      <div style={{ marginBottom: 6 }}>
        <label style={PAIR_LABEL}>Pressed</label>
        <AssetField
          assetType="image"
          value={element.pressedRef ?? ''}
          manifestStore={manifestStore}
          onChange={(v) => onMutate({ pressedRef: v })}
        />
      </div>
      <div style={{ marginBottom: 0 }}>
        <label style={PAIR_LABEL}>Fit</label>
        <select
          style={INPUT}
          value={element.fit}
          onChange={e => onMutate({ fit: e.target.value })}
        >
          <option value="fit">Fit (letterbox)</option>
          <option value="cover">Cover (crop)</option>
          <option value="stretch">Stretch</option>
          <option value="none">None (native size)</option>
        </select>
      </div>
    </>
  );
}

function RichKindRow({
  element, onMutate,
}: {
  element:  SurfaceElement & { kind: 'rich' };
  onMutate: (patch: Record<string, unknown>) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <div>
        <label style={PAIR_LABEL}>HTML</label>
        <div style={HTML_PREVIEW} title={element.html}>{element.html || '(empty)'}</div>
        <button style={{ ...SPAWN_BTN, width: '100%' }} onClick={() => setEditing(true)}>
          Edit HTML…
        </button>
      </div>
      <HtmlEditorModal
        open={editing}
        initial={element.html}
        onClose={() => setEditing(false)}
        onSave={(next) => { onMutate({ html: next }); setEditing(false); }}
      />
    </>
  );
}

function numberOr(raw: string, fallback: number): number {
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

// ── Seats Section ──────────────────────────────────────────────────────

const SEAT_ROW: React.CSSProperties = {
  display:             'grid',
  gridTemplateColumns: '20px 1fr 1fr 44px 56px',
  gap:                 4,
  alignItems:          'center',
  marginBottom:        4,
};

const SEAT_SWATCH: React.CSSProperties = {
  width:           14,
  height:          14,
  borderRadius:    3,
  border:          '1px solid var(--line-strong)',
  flex:            '0 0 auto',
  display:         'inline-block',
};

const SEAT_INPUT: React.CSSProperties = {
  ...INPUT,
  padding:  '3px 4px',
  fontSize: 11,
};

const SEAT_OCCUPANT: React.CSSProperties = {
  fontSize:     11,
  color:        'var(--ink-mute)',
  whiteSpace:   'nowrap',
  overflow:     'hidden',
  textOverflow: 'ellipsis',
};

const SEAT_EDIT_BTN: React.CSSProperties = {
  background:   'var(--bg)',
  border:       '1px solid var(--line)',
  color:        'var(--ink)',
  padding:      '3px 6px',
  borderRadius: 3,
  cursor:       'pointer',
  fontSize:     11,
  fontFamily:   'inherit',
};

function SeatsSection({
  table, roomSnapshot, getTableBounds,
  editingSeatIndex, onSetEditingSeatIndex,
  onUpdateComponentProp,
}: {
  table:                 ObjectSummary;
  roomSnapshot:          RoomStateSnapshot | null;
  getTableBounds:        () => { halfWidth: number; halfDepth: number } | null;
  editingSeatIndex:      number | null;
  onSetEditingSeatIndex: (i: number | null) => void;
  onUpdateComponentProp: (id: string, typeId: string, key: string, value: unknown) => void;
}) {
  const tableSection = table.sections.find(s => s.typeId === 'table');
  const seats = (tableSection?.state.seats as SeatState[] | undefined) ?? [];

  const writeSeats = (next: SeatState[]) => {
    onUpdateComponentProp(TABLE_ENTITY_ID, 'table', 'seats', next);
  };

  const updateSeat = (index: number, patch: Partial<SeatState>) => {
    const next = seats.map((s, i) => (i === index ? { ...s, ...patch } : s));
    writeSeats(next);
  };

  const resetAll = () => {
    const bounds = getTableBounds();
    if (!bounds) return;
    writeSeats(defaultSeatStates(bounds));
  };

  return (
    <div style={SECTION}>
      <div style={{ ...SECTION_HEADER, marginBottom: 8 }}>
        <div style={{ ...SECTION_LABEL, marginBottom: 0 }}>Seats</div>
        <button
          type="button"
          style={{
            ...SEAT_EDIT_BTN,
            padding: '3px 8px',
          }}
          onClick={resetAll}
        >
          Reset all seats
        </button>
      </div>
      {seats.length === 0 && (
        <div style={{ color: 'var(--ink-mute)', fontSize: 12 }}>No seats configured.</div>
      )}
      {seats.map((seat, i) => (
        <SeatRow
          key={i}
          index={i}
          seat={seat}
          occupantName={resolveOccupant(roomSnapshot, i)}
          isEditing={editingSeatIndex === i}
          onToggleEdit={() => onSetEditingSeatIndex(editingSeatIndex === i ? null : i)}
          onUpdate={(patch) => updateSeat(i, patch)}
        />
      ))}
    </div>
  );
}

function SeatRow({
  index, seat, occupantName, isEditing, onToggleEdit, onUpdate,
}: {
  index:        number;
  seat:         SeatState;
  occupantName: string;
  isEditing:    boolean;
  onToggleEdit: () => void;
  onUpdate:     (patch: Partial<SeatState>) => void;
}) {
  return (
    <div style={SEAT_ROW}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ ...SEAT_SWATCH, background: SEAT_COLOURS[index] }} />
      </div>
      <SeatNumberInput
        title={`Seat ${index} X`}
        value={seat.x}
        format={fmt2}
        parse={(raw) => numberOr(raw, seat.x)}
        onCommit={(v) => onUpdate({ x: v })}
      />
      <SeatNumberInput
        title={`Seat ${index} Z`}
        value={seat.z}
        format={fmt2}
        parse={(raw) => numberOr(raw, seat.z)}
        onCommit={(v) => onUpdate({ z: v })}
      />
      <SeatNumberInput
        title={`Seat ${index} yaw (degrees)`}
        value={radToDegInt(seat.yaw)}
        format={fmtInt}
        parse={(raw) => {
          const n = parseFloat(raw);
          if (!Number.isFinite(n)) return radToDegInt(seat.yaw);
          return normalizeYawDegrees(Math.round(n));
        }}
        onCommit={(deg) => onUpdate({ yaw: (deg * Math.PI) / 180 })}
      />
      <button
        type="button"
        style={{
          ...SEAT_EDIT_BTN,
          background: isEditing
            ? 'color-mix(in oklab, var(--accent) 22%, transparent)'
            : 'var(--bg)',
        }}
        title={`Drag seat ${index} in 3D`}
        onClick={onToggleEdit}
      >
        {isEditing ? 'Done' : 'Edit'}
      </button>
      <div style={{ ...SEAT_OCCUPANT, gridColumn: '2 / span 4', marginTop: -2 }}>
        {occupantName || '—'}
      </div>
    </div>
  );
}

function SeatNumberInput({
  title, value, format, parse, onCommit,
}: {
  title:    string;
  value:    number;
  format:   (n: number) => string;
  parse:    (raw: string) => number;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(() => format(value));
  // Reflect external edits (gizmo drag, remote replication) into the input
  // unless the user is mid-edit. Compare formatted values so a tiny float
  // drift doesn't ping-pong the field while typing.
  useEffect(() => { setDraft(format(value)); }, [value, format]);

  const commit = () => {
    const next = parse(draft);
    if (next !== value) onCommit(next);
    setDraft(format(next));
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      style={SEAT_INPUT}
      title={title}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        else if (e.key === 'Escape') { setDraft(format(value)); (e.target as HTMLInputElement).blur(); }
      }}
    />
  );
}

function fmt2(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

function fmtInt(n: number): string {
  return String(Math.round(Number.isFinite(n) ? n : 0));
}

function radToDegInt(rad: number): number {
  return normalizeYawDegrees(Math.round((rad * 180) / Math.PI));
}

function resolveOccupant(snap: RoomStateSnapshot | null, seatIndex: number): string {
  if (!snap) return '';
  const entry = snap.seats.find(s => s.index === seatIndex);
  if (!entry?.peerId) return '';
  return snap.names?.[entry.peerId] ?? entry.peerId.slice(0, 8);
}

// @vitest-environment jsdom
import { describe, test, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { AnchorLayout } from './AnchorLayout';
import { EditorPanel, type ObjectSummary } from './EditorPanel';
import type { ComponentSchemaSection } from '../entity/propertySchema';

afterEach(() => { cleanup(); });

function renderPanel(objects: ObjectSummary[], selectedId: string | null) {
  const selectedIds = selectedId === null ? new Set<string>() : new Set([selectedId]);
  return renderPanelMulti(objects, selectedIds);
}

function renderPanelMulti(
  objects: ObjectSummary[],
  selectedIds: ReadonlySet<string>,
  overrides: Partial<React.ComponentProps<typeof EditorPanel>> = {},
) {
  return render(
    <AnchorLayout>
      <EditorPanel
        objects={objects}
        selectedIds={selectedIds}
        isFreeCamera={false}
        manifestStore={null}
        selectedTools={[]}
        getTableBounds={() => null}
        roomSnapshot={null}
        editingSeatIndex={null}
        onSetEditingSeatIndex={noop}
        onSelect={noop}
        onRollDice={noop}
        onUpdateEntityField={noop}
        onUpdateComponentProp={noop}
        onToggleFreeCamera={noop}
        onToolAction={noop}
        onMutateElement={noop}
        onRemoveElement={noop}
        onDeleteEntity={noop}
        onDuplicateEntity={noop}
        onGroupFlip={noop}
        onGroupDelete={noop}
        onGroupDuplicate={noop}
        {...overrides}
      />
    </AnchorLayout>,
  );
}

const noop = () => {};

function makeSummary(overrides: Partial<ObjectSummary> = {}): ObjectSummary {
  return {
    id:         'e-1',
    objectType: 'token' as ObjectSummary['objectType'],
    name:       'Tok',
    owner:      null,
    tags:       [],
    customData: {},
    sections:   [],
    parentId:   null,
    surface:    null,
    ...overrides,
  };
}

describe('EditorPanel — Mesh section rendering (issue #2 of property-schema-refactor)', () => {
  test('Token entity with a Mesh section shows three rows: color, meshRef, textureUrl', () => {
    const meshSection: ComponentSchemaSection = {
      typeId: 'mesh',
      label:  'Mesh',
      state:  { color: '#abcdef', meshRef: 'prim:meeple', textureRefs: { default: 'base:tex/x' } },
      entries: [
        { key: 'color',      label: 'Color',   type: 'color' },
        { key: 'meshRef',    label: 'Mesh',    type: 'asset:model' },
        { key: 'textureUrl', label: 'Texture', type: 'asset:image',
          get: (s: any) => s.textureRefs?.default ?? '',
          set: (v, s: any) => ({ textureRefs: { ...s.textureRefs, default: String(v) } }) },
      ],
    };
    const objects: ObjectSummary[] = [makeSummary({ id: 'tok-1', sections: [meshSection] })];

    const { container, getAllByText, getByDisplayValue } = renderPanel(objects, 'tok-1');

    // Mesh header is rendered.
    expect(getAllByText(/^Mesh$/).length).toBeGreaterThan(0);
    // Color row has the current value.
    expect(getByDisplayValue('#abcdef')).toBeDefined();
    // Three labelled rows from the schema.
    expect(container.textContent).toContain('Color');
    expect(container.textContent).toContain('Texture');
  });

  test('Table entity renders four sections in topological order', () => {
    // Mirrors what aggregatePropertySchema returns for the Table singleton:
    // mesh → skydome → lighting → transform (transform topo-first; visualised
    // last in section order via topological onSpawn).
    const sections: ComponentSchemaSection[] = [
      { typeId: 'transform', label: 'Transform',
        state: { scale: [1, 1, 1] },
        entries: [{ key: 'scale', label: 'Scale', type: 'number', min: 0.0001 }] },
      { typeId: 'mesh', label: 'Mesh',
        state: { color: '#4a3728', meshRef: 'prim:table-rect', textureRefs: {} },
        entries: [
          { key: 'color', label: 'Color', type: 'color' },
          { key: 'meshRef', label: 'Mesh', type: 'asset:model' },
        ] },
      { typeId: 'skydome', label: 'Sky',
        state: { textureUrl: 'base:sky/default' },
        entries: [{ key: 'textureUrl', label: 'Texture', type: 'asset:image' }] },
      { typeId: 'lighting', label: 'Light',
        state: { color: '#fff1dc', intensity: 1.1 },
        entries: [
          { key: 'color',     label: 'Color',     type: 'color' },
          { key: 'intensity', label: 'Intensity', type: 'number', min: 0 },
        ] },
    ];
    const objects: ObjectSummary[] = [makeSummary({
      id: 'table-1', objectType: 'table' as ObjectSummary['objectType'], sections,
    })];

    const { container } = renderPanel(objects, 'table-1');
    const html = container.innerHTML;

    // All four section headers appear in the order they were aggregated.
    const idxTransform = html.indexOf('Transform');
    const idxMesh      = html.indexOf('Mesh');
    const idxSky       = html.indexOf('Sky');
    const idxLight     = html.indexOf('Light');
    expect(idxTransform).toBeGreaterThan(-1);
    expect(idxMesh).toBeGreaterThan(idxTransform);
    expect(idxSky).toBeGreaterThan(idxMesh);
    expect(idxLight).toBeGreaterThan(idxSky);

    // Scale value visible.
    expect(container.textContent).toContain('Scale');
    expect(container.textContent).toContain('Intensity');
  });

  test('host-only row is absent from the DOM in guest context (issue #7 of property-schema-refactor)', () => {
    // Mirrors what aggregatePropertySchema returns for a guest viewing the
    // Table singleton: the Sky section's textureUrl entry is hostOnly, so the
    // aggregator strips it from `entries` and the panel never renders the row.
    const hostSection: ComponentSchemaSection = {
      typeId: 'skydome',
      label:  'Sky',
      state:  { textureUrl: 'base:sky/default' },
      entries: [
        { key: 'textureUrl', label: 'Texture', type: 'asset:image', hostOnly: true },
      ],
    };
    const guestSection: ComponentSchemaSection = {
      typeId: 'skydome',
      label:  'Sky',
      state:  { textureUrl: 'base:sky/default' },
      entries: [],  // hostOnly entry already filtered by aggregator
    };

    const hostRender = renderPanel(
      [makeSummary({ id: 't-1', sections: [hostSection] })], 't-1',
    );
    expect(hostRender.container.textContent).toContain('Texture');
    cleanup();

    const guestRender = renderPanel(
      [makeSummary({ id: 't-1', sections: [guestSection] })], 't-1',
    );
    // The hostOnly row's label is absent from the DOM entirely — the
    // aggregator strips the entry, so the panel renders an empty Sky section
    // (placeholder text, not a hidden Texture row).
    expect(guestRender.container.textContent).not.toContain('Texture');
    expect(guestRender.container.textContent).toContain('Sky');
  });

  test('size-0 selection shows the empty state (no Entity section)', () => {
    const objects: ObjectSummary[] = [makeSummary({ id: 'a' }), makeSummary({ id: 'b' })];
    const { container } = renderPanelMulti(objects, new Set());
    // Empty selection: PropertyEditor renders its prompt; no Entity section.
    expect(container.textContent).toContain('Select an object to edit its properties');
    expect(container.textContent).not.toContain('Entity —');
  });

  test('size-N selection swaps to the group panel — no property fields', () => {
    const meshSection: ComponentSchemaSection = {
      typeId: 'mesh', label: 'Mesh',
      state: { color: '#ff00ff', meshRef: 'prim:cube', textureRefs: {} },
      entries: [{ key: 'color', label: 'Color', type: 'color' }],
    };
    const objects: ObjectSummary[] = [
      makeSummary({ id: 'a', sections: [meshSection] }),
      makeSummary({ id: 'b', sections: [meshSection] }),
      makeSummary({ id: 'c', sections: [meshSection] }),
    ];
    const { container } = renderPanelMulti(objects, new Set(['a', 'b', 'c']));
    expect(container.textContent).toContain('3 selected');
    // Group action buttons present.
    expect(container.textContent).toContain('Flip');
    expect(container.textContent).toContain('Rotate');
    expect(container.textContent).toContain('Delete');
    expect(container.textContent).toContain('Duplicate');
    // Per-entity property rows are absent — no Color field, no Entity section.
    expect(container.textContent).not.toContain('Entity —');
    expect(container.querySelector('input[type="color"]')).toBeNull();
  });

  test('group Flip / Delete / Duplicate buttons fire the fan-out callbacks (issue #4)', () => {
    const calls: string[] = [];
    const objects: ObjectSummary[] = [
      makeSummary({ id: 'a' }), makeSummary({ id: 'b' }),
    ];
    const { getByText } = renderPanelMulti(objects, new Set(['a', 'b']), {
      onGroupFlip:      () => calls.push('flip'),
      onGroupDelete:    () => calls.push('delete'),
      onGroupDuplicate: () => calls.push('duplicate'),
    });
    fireEvent.click(getByText('Flip'));
    fireEvent.click(getByText('Delete'));
    fireEvent.click(getByText('Duplicate'));
    expect(calls).toEqual(['flip', 'delete', 'duplicate']);
  });

  test('size-1 selection still renders the existing property editor', () => {
    const meshSection: ComponentSchemaSection = {
      typeId: 'mesh', label: 'Mesh',
      state: { color: '#123456', meshRef: 'prim:cube', textureRefs: {} },
      entries: [{ key: 'color', label: 'Color', type: 'color' }],
    };
    const objects: ObjectSummary[] = [makeSummary({ id: 'a', sections: [meshSection] })];
    const { container, getByDisplayValue } = renderPanelMulti(objects, new Set(['a']));
    expect(container.textContent).toContain('Entity —');
    expect(getByDisplayValue('#123456')).toBeDefined();
    expect(container.textContent).not.toMatch(/\d+ selected/);
  });

  test('Entity section renders above component sections with Name / Owner / Tags', () => {
    const meshSection: ComponentSchemaSection = {
      typeId: 'mesh',
      label:  'Mesh',
      state:  { color: '#fff', meshRef: 'prim:cube', textureRefs: {} },
      entries: [{ key: 'color', label: 'Color', type: 'color' }],
    };
    const objects: ObjectSummary[] = [makeSummary({
      id: 'tok-2', name: 'My Token', sections: [meshSection],
    })];

    const { container } = renderPanel(objects, 'tok-2');

    expect(container.textContent).toContain('Entity');
    expect(container.textContent).toContain('Name');
    expect(container.textContent).toContain('Owner');
    expect(container.textContent).toContain('Tags');
    // Entity section appears before Mesh section.
    const html = container.innerHTML;
    expect(html.indexOf('Entity')).toBeLessThan(html.indexOf('Mesh'));
  });
});

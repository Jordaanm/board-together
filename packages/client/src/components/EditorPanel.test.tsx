// @vitest-environment jsdom
import { describe, test, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { AnchorLayout } from './AnchorLayout';
import { EditorPanel, type ObjectSummary } from './EditorPanel';
import type { ComponentSchemaSection } from '../entity/propertySchema';

afterEach(() => { cleanup(); });

function renderPanel(objects: ObjectSummary[], selectedId: string | null) {
  return render(
    <AnchorLayout>
      <EditorPanel
        objects={objects}
        selectedId={selectedId}
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

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { SceneImpl } from '../Scene';
import { type SpawnContext } from '../EntityComponent';
import { registerCorePrimitives } from '../spawnables';
import { PhysicsWorld } from '../../physics/PhysicsWorld';
import { PdfComponent, type PdfMutatorContext } from './PdfComponent';
import { MeshComponent } from './MeshComponent';
import { assetService } from '../../assets/AssetService';
import { Manifest, type AssetEntry } from '../../assets/Manifest';
import { BASE_MANIFEST, PRIMITIVE_MANIFEST } from '../../assets/baseManifest';
import { formatPdfRef } from '../../assets/pdfRef';

let scene: SceneImpl;
let ctx:   SpawnContext;

const PDF_HASH = 'a'.repeat(64);
const pdfEntry: AssetEntry = {
  slug:        'custom:my-doc',
  name:        'My doc',
  type:        'pdf',
  url:         '',
  preload:     false,
  bundled:     true,
  hash:        PDF_HASH,
  size:        16,
  aspectRatio: 0.5,   // square-ish so depth = width/0.5 = 2*width
  pageCount:   5,
};

beforeEach(() => {
  registerCorePrimitives();
  scene = new SceneImpl();
  ctx   = { scene: new THREE.Scene(), physics: new PhysicsWorld(), entityScene: scene };
  assetService.setManifests([BASE_MANIFEST, PRIMITIVE_MANIFEST, Manifest.from([pdfEntry])]);
});

afterEach(() => {
  assetService.setManifests([BASE_MANIFEST, PRIMITIVE_MANIFEST]);
});

const SEATED:    PdfMutatorContext = { recipientSeat: 0 };
const SPECTATOR: PdfMutatorContext = { recipientSeat: null };

describe('PdfComponent — spawn', () => {
  test('spawn produces an entity with the pdf component', () => {
    const e = scene.spawn('pdf', ctx);
    const pdf = e.getComponent(PdfComponent)!;
    expect(pdf.state.assetSlug).toBe('');
    expect(pdf.state.currentPage).toBe(1);
  });

  test('default spawn carries a prim:page mesh with letter-aspect dimensions', () => {
    const e = scene.spawn('pdf', ctx);
    const mesh = e.getComponent(MeshComponent)!;
    expect(mesh.state.meshRef).toBe('prim:page');
    expect(mesh.state.width).toBeCloseTo(1.0);
    expect(mesh.state.depth).toBeCloseTo(1.29);
  });

  test('default tags include "pdf"', () => {
    const e = scene.spawn('pdf', ctx);
    expect(e.tags).toContain('pdf');
  });
});

describe('PdfComponent — assetSlug → textureRefs.face', () => {
  test('picking an assetSlug sets mesh.textureRefs.face to pdf:<slug>/page/1', () => {
    const e = scene.spawn('pdf', ctx);
    e.getComponent(PdfComponent)!.setState({ assetSlug: 'custom:my-doc' });
    const mesh = e.getComponent(MeshComponent)!;
    expect(mesh.state.textureRefs.face).toBe(formatPdfRef('custom:my-doc', 1));
  });

  test('clearing assetSlug clears textureRefs.face', () => {
    const e = scene.spawn('pdf', ctx);
    const pdf = e.getComponent(PdfComponent)!;
    pdf.setState({ assetSlug: 'custom:my-doc' });
    pdf.setState({ assetSlug: '' });
    expect(e.getComponent(MeshComponent)!.state.textureRefs.face).toBe('');
  });
});

describe('PdfComponent — aspectRatio sizing', () => {
  test('setting assetSlug recomputes mesh.depth as width / aspectRatio', () => {
    const e = scene.spawn('pdf', ctx);
    e.getComponent(PdfComponent)!.setState({ assetSlug: 'custom:my-doc' });
    const mesh = e.getComponent(MeshComponent)!;
    expect(mesh.state.depth).toBeCloseTo(mesh.state.width / 0.5);
  });
});

describe('PdfComponent — page mutators (seat-gated)', () => {
  test('setPage with a seated context updates currentPage and rewires the texture ref', () => {
    const e = scene.spawn('pdf', ctx);
    const pdf = e.getComponent(PdfComponent)!;
    pdf.setState({ assetSlug: 'custom:my-doc' });
    pdf.setPage(3, SEATED);
    expect(pdf.state.currentPage).toBe(3);
    expect(e.getComponent(MeshComponent)!.state.textureRefs.face).toBe(formatPdfRef('custom:my-doc', 3));
  });

  test('setPage(0) clamps to 1; setPage(pageCount + 1) clamps to pageCount', () => {
    const e = scene.spawn('pdf', ctx);
    const pdf = e.getComponent(PdfComponent)!;
    pdf.setState({ assetSlug: 'custom:my-doc' });
    pdf.setPage(0, SEATED);
    expect(pdf.state.currentPage).toBe(1);
    pdf.setPage(99, SEATED);
    expect(pdf.state.currentPage).toBe(5);
  });

  test('nextPage past the last page is a no-op', () => {
    const e = scene.spawn('pdf', ctx);
    const pdf = e.getComponent(PdfComponent)!;
    pdf.setState({ assetSlug: 'custom:my-doc', currentPage: 5 });
    pdf.nextPage(SEATED);
    expect(pdf.state.currentPage).toBe(5);
  });

  test('previousPage before page 1 is a no-op', () => {
    const e = scene.spawn('pdf', ctx);
    const pdf = e.getComponent(PdfComponent)!;
    pdf.setState({ assetSlug: 'custom:my-doc' });
    pdf.previousPage(SEATED);
    expect(pdf.state.currentPage).toBe(1);
  });

  test('spectator setPage is a no-op', () => {
    const e = scene.spawn('pdf', ctx);
    const pdf = e.getComponent(PdfComponent)!;
    pdf.setState({ assetSlug: 'custom:my-doc' });
    pdf.setPage(4, SPECTATOR);
    expect(pdf.state.currentPage).toBe(1);
  });
});

describe('PdfComponent — pdf:page-changed events', () => {
  test('fires { from, to } on every successful page change', () => {
    const e = scene.spawn('pdf', ctx);
    const pdf = e.getComponent(PdfComponent)!;
    pdf.setState({ assetSlug: 'custom:my-doc' });
    const events: Array<{ from: number; to: number }> = [];
    e.addEventListener('pdf:page-changed', (p) => events.push(p as { from: number; to: number }));
    pdf.setPage(3, SEATED);
    pdf.nextPage(SEATED);
    pdf.previousPage(SEATED);
    expect(events).toEqual([
      { from: 1, to: 3 },
      { from: 3, to: 4 },
      { from: 4, to: 3 },
    ]);
  });

  test('does not fire when setPage results in no change', () => {
    const e = scene.spawn('pdf', ctx);
    const pdf = e.getComponent(PdfComponent)!;
    pdf.setState({ assetSlug: 'custom:my-doc' });
    const events: Array<unknown> = [];
    e.addEventListener('pdf:page-changed', (p) => events.push(p));
    pdf.setPage(1, SEATED);  // already on page 1
    expect(events).toEqual([]);
  });
});

describe('PdfComponent — bag interaction', () => {
  test('a pdf entity is accepted by a default bag (no acceptComponents filter)', () => {
    const bag = scene.spawn('bag', ctx);
    const pdf = scene.spawn('pdf', ctx);
    // Bag zone has no acceptComponents filter, so all entity types qualify.
    const zone = (bag.components.get('zone') as { state: { acceptComponents?: string[] } } | undefined)?.state;
    expect(zone?.acceptComponents).toBeUndefined();
    // Smoke-check entity is well-formed.
    expect(pdf.components.has('pdf')).toBe(true);
  });
});

describe('PdfComponent — onAction', () => {
  function actionCtx(seat: number | null) {
    return {
      recipientSeat: seat as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | null,
      isHost:        true,
      entity:        undefined as never,  // unused by PdfComponent.onAction
      preferences:   {} as never,
    };
  }

  test('pdf-next advances when seated', () => {
    const e = scene.spawn('pdf', ctx);
    const pdf = e.getComponent(PdfComponent)!;
    pdf.setState({ assetSlug: 'custom:my-doc' });
    pdf.onAction('pdf-next', { ...actionCtx(0), entity: e });
    expect(pdf.state.currentPage).toBe(2);
  });

  test('pdf-prev rewinds when seated', () => {
    const e = scene.spawn('pdf', ctx);
    const pdf = e.getComponent(PdfComponent)!;
    pdf.setState({ assetSlug: 'custom:my-doc', currentPage: 3 });
    pdf.onAction('pdf-prev', { ...actionCtx(0), entity: e });
    expect(pdf.state.currentPage).toBe(2);
  });

  test('pdf-next is a no-op for a spectator', () => {
    const e = scene.spawn('pdf', ctx);
    const pdf = e.getComponent(PdfComponent)!;
    pdf.setState({ assetSlug: 'custom:my-doc' });
    pdf.onAction('pdf-next', { ...actionCtx(null), entity: e });
    expect(pdf.state.currentPage).toBe(1);
  });
});

describe('PdfComponent — save/load round-trip', () => {
  test('JSON round-trips assetSlug and currentPage', () => {
    const fresh = new PdfComponent();
    fresh.fromJSON({ assetSlug: 'custom:my-doc', currentPage: 3 });
    const json = fresh.toJSON();
    expect(json).toEqual({ assetSlug: 'custom:my-doc', currentPage: 3 });

    const reloaded = new PdfComponent();
    reloaded.fromJSON(json);
    expect(reloaded.toJSON()).toEqual(json);
  });
});

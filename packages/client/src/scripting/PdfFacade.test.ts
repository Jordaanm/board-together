import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { SceneImpl } from '../entity/Scene';
import { type SpawnContext } from '../entity/EntityComponent';
import { registerCorePrimitives } from '../entity/spawnables';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { PdfComponent } from '../entity/components/PdfComponent';
import { SceneFacade } from './SceneFacade';
import { type ScriptRunContext } from './EntityFacade';
import { type PdfOps } from './PdfFacade';
import { assetService } from '../assets/AssetService';
import { Manifest, type AssetEntry } from '../assets/Manifest';
import { BASE_MANIFEST, PRIMITIVE_MANIFEST } from '../assets/baseManifest';

const pdfEntry: AssetEntry = {
  slug:        'custom:doc',
  name:        'Doc',
  type:        'pdf',
  url:         '',
  preload:     false,
  bundled:     true,
  hash:        'a'.repeat(64),
  size:        16,
  aspectRatio: 0.77,
  pageCount:   5,
};

let scene: SceneImpl;
let ctx:   SpawnContext;
let runCtx: ScriptRunContext;

function hostPdfOps(): PdfOps {
  return {
    setPage: (entityId, page) => {
      const e = scene.getEntity(entityId);
      e?.getComponent(PdfComponent)?.setPageDirect(page);
    },
    nextPage: (entityId) => {
      const e = scene.getEntity(entityId);
      e?.getComponent(PdfComponent)?.nextPageDirect();
    },
    previousPage: (entityId) => {
      const e = scene.getEntity(entityId);
      e?.getComponent(PdfComponent)?.previousPageDirect();
    },
  };
}

beforeEach(() => {
  registerCorePrimitives();
  scene  = new SceneImpl();
  ctx    = { scene: new THREE.Scene(), physics: new PhysicsWorld(), entityScene: scene };
  runCtx = { registrations: [] };
  assetService.setManifests([BASE_MANIFEST, PRIMITIVE_MANIFEST, Manifest.from([pdfEntry])]);
});

afterEach(() => {
  assetService.setManifests([BASE_MANIFEST, PRIMITIVE_MANIFEST]);
});

function host(): SceneFacade {
  return new SceneFacade(scene, runCtx, { pdfOps: hostPdfOps() });
}

function guest(): SceneFacade {
  // No pdfOps → guest-equivalent. Sandbox-warn recording for the
  // host-only-enforcement assertions.
  return new SceneFacade(scene, runCtx);
}

describe('EntityFacade.pdf — getter', () => {
  test('returns a PdfFacade for an entity carrying PdfComponent', () => {
    const e = scene.spawn('pdf', ctx);
    const facade = host().getObjectById(e.id)!;
    expect(facade.pdf).not.toBeNull();
  });

  test('returns null for a non-PDF entity', () => {
    const die = scene.spawn('die', ctx);
    const facade = host().getObjectById(die.id)!;
    expect(facade.pdf).toBeNull();
  });
});

describe('PdfFacade — read', () => {
  test('currentPage / pageCount / assetSlug reflect entity state', () => {
    const e = scene.spawn('pdf', ctx);
    e.getComponent(PdfComponent)!.setState({ assetSlug: 'custom:doc', currentPage: 3 });
    const pdf = host().getObjectById(e.id)!.pdf!;
    expect(pdf.currentPage).toBe(3);
    expect(pdf.pageCount).toBe(5);
    expect(pdf.assetSlug).toBe('custom:doc');
  });

  test('pageCount is 0 when no slug is assigned', () => {
    const e = scene.spawn('pdf', ctx);
    const pdf = host().getObjectById(e.id)!.pdf!;
    expect(pdf.pageCount).toBe(0);
    expect(pdf.assetSlug).toBe('');
  });
});

describe('PdfFacade — host writes', () => {
  test('setPage flips the entity to the requested page', () => {
    const e = scene.spawn('pdf', ctx);
    e.getComponent(PdfComponent)!.setState({ assetSlug: 'custom:doc' });
    host().getObjectById(e.id)!.pdf!.setPage(4);
    expect(e.getComponent(PdfComponent)!.state.currentPage).toBe(4);
  });

  test('setPage clamps low / high without throwing', () => {
    const e = scene.spawn('pdf', ctx);
    e.getComponent(PdfComponent)!.setState({ assetSlug: 'custom:doc' });
    const pdf = host().getObjectById(e.id)!.pdf!;
    pdf.setPage(0);
    expect(e.getComponent(PdfComponent)!.state.currentPage).toBe(1);
    pdf.setPage(999);
    expect(e.getComponent(PdfComponent)!.state.currentPage).toBe(5);
  });

  test('nextPage past last page is a no-op', () => {
    const e = scene.spawn('pdf', ctx);
    e.getComponent(PdfComponent)!.setState({ assetSlug: 'custom:doc', currentPage: 5 });
    host().getObjectById(e.id)!.pdf!.nextPage();
    expect(e.getComponent(PdfComponent)!.state.currentPage).toBe(5);
  });

  test('previousPage before page 1 is a no-op', () => {
    const e = scene.spawn('pdf', ctx);
    e.getComponent(PdfComponent)!.setState({ assetSlug: 'custom:doc' });
    host().getObjectById(e.id)!.pdf!.previousPage();
    expect(e.getComponent(PdfComponent)!.state.currentPage).toBe(1);
  });

  test('pdf-page-changed fires on every successful flip', () => {
    const e = scene.spawn('pdf', ctx);
    e.getComponent(PdfComponent)!.setState({ assetSlug: 'custom:doc' });
    const events: Array<{ from: number; to: number }> = [];
    e.addEventListener('pdf:page-changed', (p) => events.push(p as { from: number; to: number }));
    const pdf = host().getObjectById(e.id)!.pdf!;
    pdf.setPage(3);
    pdf.nextPage();
    expect(events).toEqual([
      { from: 1, to: 3 },
      { from: 3, to: 4 },
    ]);
  });
});

describe('PdfFacade — guest enforcement', () => {
  test('setPage / nextPage / previousPage warn + no-op without pdfOps wired', () => {
    const e = scene.spawn('pdf', ctx);
    e.getComponent(PdfComponent)!.setState({ assetSlug: 'custom:doc' });
    const warn = vi.fn();
    runCtx.warn = warn;
    const pdf = guest().getObjectById(e.id)!.pdf!;
    pdf.setPage(3);
    pdf.nextPage();
    pdf.previousPage();
    expect(e.getComponent(PdfComponent)!.state.currentPage).toBe(1);
    expect(warn).toHaveBeenCalledTimes(3);
    for (const call of warn.mock.calls) {
      expect(call[0]).toMatch(/no-op \(host-only API/);
    }
  });
});

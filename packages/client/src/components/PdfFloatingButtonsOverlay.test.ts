// @vitest-environment jsdom
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { SceneImpl } from '../entity/Scene';
import { type SpawnContext } from '../entity/EntityComponent';
import { registerCorePrimitives } from '../entity/spawnables';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { PdfComponent } from '../entity/components/PdfComponent';
import { assetService } from '../assets/AssetService';
import { Manifest, type AssetEntry } from '../assets/Manifest';
import { BASE_MANIFEST, PRIMITIVE_MANIFEST } from '../assets/baseManifest';
import { PdfFloatingButtonsOverlay } from './PdfFloatingButtonsOverlay';

const PDF_HASH = 'b'.repeat(64);
const pdfEntry: AssetEntry = {
  slug:        'custom:doc',
  name:        'Doc',
  type:        'pdf',
  url:         '',
  preload:     false,
  bundled:     true,
  hash:        PDF_HASH,
  size:        16,
  aspectRatio: 0.77,
  pageCount:   5,
};

let scene:  SceneImpl;
let ctx:    SpawnContext;
let parent: HTMLDivElement;
let camera: THREE.PerspectiveCamera;
let canvas: HTMLCanvasElement;

beforeEach(() => {
  registerCorePrimitives();
  scene = new SceneImpl();
  ctx   = { scene: new THREE.Scene(), physics: new PhysicsWorld(), entityScene: scene };
  assetService.setManifests([BASE_MANIFEST, PRIMITIVE_MANIFEST, Manifest.from([pdfEntry])]);

  parent = document.createElement('div');
  document.body.appendChild(parent);

  canvas = document.createElement('canvas');
  // jsdom doesn't compute layout — stub getBoundingClientRect.
  canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 800, bottom: 600,
    width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
  document.body.appendChild(canvas);

  camera = new THREE.PerspectiveCamera(60, 800 / 600, 0.1, 100);
  camera.position.set(0, 5, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
});

afterEach(() => {
  parent.remove();
  canvas.remove();
  assetService.setManifests([BASE_MANIFEST, PRIMITIVE_MANIFEST]);
});

function spawnPdfEntity(slug = 'custom:doc') {
  const e = scene.spawn('pdf', ctx);
  e.getComponent(PdfComponent)!.setState({ assetSlug: slug });
  // SceneImpl spawn rolls onSpawn through transform → mesh → … so the
  // entity's TransformComponent.object3d is at world origin. Make sure
  // the matrix world is current for projection.
  const transform = e.components.get('transform') as unknown as { object3d: THREE.Object3D };
  transform.object3d.updateMatrixWorld(true);
  return e;
}

describe('PdfFloatingButtonsOverlay', () => {
  test('hidden when no entity is hovered or selected', () => {
    const overlay = new PdfFloatingButtonsOverlay(parent, {
      onPrev: vi.fn(), onNext: vi.fn(), onOpen: vi.fn(),
    }, { subscribeStatus: (_ref, cb) => { cb('loaded'); return () => {}; } });
    overlay.update({ camera, canvas, hoveredEntity: null, selectedEntity: null });
    const buttons = parent.querySelectorAll('button');
    expect(buttons.length).toBe(3);
    for (const b of buttons) expect((b as HTMLButtonElement).style.display).toBe('none');
  });

  test('hidden when hovered entity is not a PDF', () => {
    const overlay = new PdfFloatingButtonsOverlay(parent, {
      onPrev: vi.fn(), onNext: vi.fn(), onOpen: vi.fn(),
    }, { subscribeStatus: (_ref, cb) => { cb('loaded'); return () => {}; } });
    const die = scene.spawn('die', ctx);
    overlay.update({ camera, canvas, hoveredEntity: die, selectedEntity: null });
    const buttons = parent.querySelectorAll('button');
    for (const b of buttons) expect((b as HTMLButtonElement).style.display).toBe('none');
  });

  test('hidden when hovered PDF has no assetSlug', () => {
    const overlay = new PdfFloatingButtonsOverlay(parent, {
      onPrev: vi.fn(), onNext: vi.fn(), onOpen: vi.fn(),
    }, { subscribeStatus: (_ref, cb) => { cb('loaded'); return () => {}; } });
    const e = scene.spawn('pdf', ctx);
    overlay.update({ camera, canvas, hoveredEntity: e, selectedEntity: null });
    for (const b of parent.querySelectorAll('button')) {
      expect((b as HTMLButtonElement).style.display).toBe('none');
    }
  });

  test('visible when a configured PDF is hovered; page indicator shows current / total', () => {
    const overlay = new PdfFloatingButtonsOverlay(parent, {
      onPrev: vi.fn(), onNext: vi.fn(), onOpen: vi.fn(),
    }, { subscribeStatus: (_ref, cb) => { cb('loaded'); return () => {}; } });
    const e = spawnPdfEntity();
    e.getComponent(PdfComponent)!.setState({ currentPage: 2 });
    overlay.update({ camera, canvas, hoveredEntity: e, selectedEntity: null });
    const buttons = parent.querySelectorAll('button');
    for (const b of buttons) expect((b as HTMLButtonElement).style.display).toBe('block');
    const indicator = parent.querySelector('div')!;
    expect(indicator.textContent).toBe('2 / 5');
  });

  test('falls back to selected PDF when nothing is hovered', () => {
    const overlay = new PdfFloatingButtonsOverlay(parent, {
      onPrev: vi.fn(), onNext: vi.fn(), onOpen: vi.fn(),
    }, { subscribeStatus: (_ref, cb) => { cb('loaded'); return () => {}; } });
    const e = spawnPdfEntity();
    overlay.update({ camera, canvas, hoveredEntity: null, selectedEntity: e });
    for (const b of parent.querySelectorAll('button')) {
      expect((b as HTMLButtonElement).style.display).toBe('block');
    }
  });

  test('Prev disabled at page 1; Next disabled at last page', () => {
    const overlay = new PdfFloatingButtonsOverlay(parent, {
      onPrev: vi.fn(), onNext: vi.fn(), onOpen: vi.fn(),
    }, { subscribeStatus: (_ref, cb) => { cb('loaded'); return () => {}; } });
    const e = spawnPdfEntity();
    overlay.update({ camera, canvas, hoveredEntity: e, selectedEntity: null });
    const [prev, next] = parent.querySelectorAll('button');
    expect((prev as HTMLButtonElement).disabled).toBe(true);
    expect((next as HTMLButtonElement).disabled).toBe(false);

    e.getComponent(PdfComponent)!.setState({ currentPage: 5 });
    overlay.update({ camera, canvas, hoveredEntity: e, selectedEntity: null });
    expect((prev as HTMLButtonElement).disabled).toBe(false);
    expect((next as HTMLButtonElement).disabled).toBe(true);
  });

  test('button clicks fan out to the supplied callbacks with the target entity id', () => {
    const onPrev = vi.fn(), onNext = vi.fn(), onOpen = vi.fn();
    const overlay = new PdfFloatingButtonsOverlay(parent, { onPrev, onNext, onOpen },
      { subscribeStatus: (_ref, cb) => { cb('loaded'); return () => {}; } });
    const e = spawnPdfEntity();
    e.getComponent(PdfComponent)!.setState({ currentPage: 3 });
    overlay.update({ camera, canvas, hoveredEntity: e, selectedEntity: null });
    const [prev, next, open] = parent.querySelectorAll('button');
    (next as HTMLButtonElement).click();
    (prev as HTMLButtonElement).click();
    (open as HTMLButtonElement).click();
    expect(onNext).toHaveBeenCalledWith(e.id);
    expect(onPrev).toHaveBeenCalledWith(e.id);
    expect(onOpen).toHaveBeenCalledWith(e.id);
  });

  test('hover wins over selection when both are set', () => {
    const overlay = new PdfFloatingButtonsOverlay(parent, {
      onPrev: vi.fn(), onNext: vi.fn(), onOpen: vi.fn(),
    }, { subscribeStatus: (_ref, cb) => { cb('loaded'); return () => {}; } });
    const hovered  = spawnPdfEntity();
    hovered.getComponent(PdfComponent)!.setState({ currentPage: 2 });
    const selected = spawnPdfEntity();
    selected.getComponent(PdfComponent)!.setState({ currentPage: 4 });
    overlay.update({ camera, canvas, hoveredEntity: hovered, selectedEntity: selected });
    const indicator = parent.querySelector('div')!;
    expect(indicator.textContent).toBe('2 / 5');
  });

  test('pending status disables every button and shows the Loading badge', () => {
    let emit: ((s: 'pending' | 'loaded' | 'broken') => void) | null = null;
    const overlay = new PdfFloatingButtonsOverlay(parent, {
      onPrev: vi.fn(), onNext: vi.fn(), onOpen: vi.fn(),
    }, { subscribeStatus: (_ref, cb) => { emit = cb; cb('pending'); return () => {}; } });
    const e = spawnPdfEntity();
    overlay.update({ camera, canvas, hoveredEntity: e, selectedEntity: null });
    const [prev, next, open] = parent.querySelectorAll('button');
    expect((prev as HTMLButtonElement).disabled).toBe(true);
    expect((next as HTMLButtonElement).disabled).toBe(true);
    expect((open as HTMLButtonElement).disabled).toBe(true);
    const badge = Array.from(parent.querySelectorAll('div'))
      .find((d) => (d.textContent ?? '') === 'Loading…');
    expect(badge).toBeTruthy();
    // Transition to loaded → buttons re-enable, badge hides.
    emit!('loaded');
    overlay.update({ camera, canvas, hoveredEntity: e, selectedEntity: null });
    expect((next as HTMLButtonElement).disabled).toBe(false);
  });

  test('broken status hides buttons and shows the PDF-unavailable label', () => {
    const overlay = new PdfFloatingButtonsOverlay(parent, {
      onPrev: vi.fn(), onNext: vi.fn(), onOpen: vi.fn(),
    }, { subscribeStatus: (_ref, cb) => { cb('broken'); return () => {}; } });
    const e = spawnPdfEntity();
    overlay.update({ camera, canvas, hoveredEntity: e, selectedEntity: null });
    for (const b of parent.querySelectorAll('button')) {
      expect((b as HTMLButtonElement).style.display).toBe('none');
    }
    const badge = Array.from(parent.querySelectorAll('div'))
      .find((d) => (d.textContent ?? '') === 'PDF unavailable');
    expect(badge).toBeTruthy();
    expect((badge as HTMLElement).style.display).toBe('block');
  });

  test('hide() detaches every overlay element on dispose', () => {
    const overlay = new PdfFloatingButtonsOverlay(parent, {
      onPrev: vi.fn(), onNext: vi.fn(), onOpen: vi.fn(),
    }, { subscribeStatus: (_ref, cb) => { cb('loaded'); return () => {}; } });
    overlay.dispose();
    expect(parent.children.length).toBe(0);
  });
});

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { SceneImpl } from '../entity/Scene';
import { type SpawnContext } from '../entity/EntityComponent';
import { registerCorePrimitives } from '../entity/spawnables';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { BagComponent } from '../entity/components/BagComponent';
import { DeckComponent } from '../entity/components/DeckComponent';
import { PdfComponent } from '../entity/components/PdfComponent';
import {
  resolveContainerTooltip,
  resolvePdfTooltip,
  resolveTooltipText,
} from './HoverTooltipOverlay';
import { assetService } from '../assets/AssetService';
import { Manifest, type AssetEntry } from '../assets/Manifest';
import { BASE_MANIFEST, PRIMITIVE_MANIFEST } from '../assets/baseManifest';

const pdfEntry: AssetEntry = {
  slug:        'custom:doc',
  name:        'Rulebook',
  type:        'pdf',
  url:         '',
  preload:     false,
  bundled:     true,
  hash:        'a'.repeat(64),
  size:        12,
  aspectRatio: 0.77,
  pageCount:   12,
};

let scene: SceneImpl;
let ctx: SpawnContext;

beforeEach(() => {
  registerCorePrimitives();
  scene = new SceneImpl();
  ctx = { scene: new THREE.Scene(), physics: new PhysicsWorld(), entityScene: scene };
  assetService.setManifests([BASE_MANIFEST, PRIMITIVE_MANIFEST, Manifest.from([pdfEntry])]);
});

afterEach(() => {
  assetService.setManifests([BASE_MANIFEST, PRIMITIVE_MANIFEST]);
});

describe('resolveContainerTooltip', () => {
  test('returns null for a non-container entity (die)', () => {
    const die = scene.spawn('die', ctx);
    expect(resolveContainerTooltip(die)).toBeNull();
  });

  test('returns count + label for a bag', () => {
    const bag = scene.spawn('bag', ctx);
    bag.getComponent(BagComponent)!.state.contents = ['a', 'b', 'c'];
    bag.getComponent(BagComponent)!.state.label    = 'dice';
    expect(resolveContainerTooltip(bag)).toEqual({ count: 3, label: 'dice' });
  });

  test('returns count + label for a deck', () => {
    const deck = scene.spawn('deck', ctx);
    deck.getComponent(DeckComponent)!.setState({ cards: ['x', 'y'], label: 'spells' });
    expect(resolveContainerTooltip(deck)).toEqual({ count: 2, label: 'spells' });
  });

  test('reports zero count for an empty container', () => {
    const bag = scene.spawn('bag', ctx);
    expect(resolveContainerTooltip(bag)).toEqual({ count: 0, label: 'items' });
  });
});

describe('resolvePdfTooltip', () => {
  test('returns "<name> — <page>/<pageCount>" for a configured PDF entity', () => {
    const e = scene.spawn('pdf', ctx);
    const pdf = e.getComponent(PdfComponent)!;
    pdf.setState({ assetSlug: 'custom:doc' });
    expect(resolvePdfTooltip(e)).toBe('Rulebook — 1/12');
  });

  test('updates after the entity flips its page', () => {
    const e = scene.spawn('pdf', ctx);
    const pdf = e.getComponent(PdfComponent)!;
    pdf.setState({ assetSlug: 'custom:doc' });
    pdf.setPage(5, { recipientSeat: 0 });
    expect(resolvePdfTooltip(e)).toBe('Rulebook — 5/12');
  });

  test('returns null when the PDF entity has no assigned slug', () => {
    const e = scene.spawn('pdf', ctx);
    expect(resolvePdfTooltip(e)).toBeNull();
  });

  test('returns null for non-PDF entities', () => {
    const die = scene.spawn('die', ctx);
    expect(resolvePdfTooltip(die)).toBeNull();
  });

  test('falls back to "<name> — page N" when pageCount is unknown', () => {
    const noCount: AssetEntry = { ...pdfEntry, slug: 'custom:doc2', pageCount: undefined };
    assetService.setManifests([
      BASE_MANIFEST, PRIMITIVE_MANIFEST,
      Manifest.from([pdfEntry, noCount]),
    ]);
    const e = scene.spawn('pdf', ctx);
    e.getComponent(PdfComponent)!.setState({ assetSlug: 'custom:doc2' });
    expect(resolvePdfTooltip(e)).toBe('Rulebook — page 1');
  });
});

describe('resolveTooltipText', () => {
  test('returns the PDF tooltip for a configured PDF entity', () => {
    const e = scene.spawn('pdf', ctx);
    e.getComponent(PdfComponent)!.setState({ assetSlug: 'custom:doc' });
    expect(resolveTooltipText(e)).toBe('Rulebook — 1/12');
  });

  test('returns the container tooltip for a deck', () => {
    const deck = scene.spawn('deck', ctx);
    deck.getComponent(DeckComponent)!.setState({ cards: ['x'], label: 'spells' });
    expect(resolveTooltipText(deck)).toBe('1 spells');
  });

  test('returns null for a non-PDF, non-container entity', () => {
    const die = scene.spawn('die', ctx);
    expect(resolveTooltipText(die)).toBeNull();
  });
});

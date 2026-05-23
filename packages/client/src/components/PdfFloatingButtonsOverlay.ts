// HTML overlay for the PDF entity's in-world floating buttons.
// Mirrors the lifecycle shape of `HoverTooltipOverlay` — a small
// off-React DOM widget driven by ThreeCanvas's per-frame loop — so
// position updates don't pay a React re-render every frame.
//
// Three buttons (Prev / Next / Open) plus a page indicator. The
// overlay shows for the local viewer's hover-target PDF, falling back
// to the selected PDF when nothing is hovered. State mutation goes
// through the standard `dispatchAction` path so guests fire
// `invoke-action` and host-side seat gating is consistent with every
// other action.

import * as THREE from 'three';
import { type Entity } from '../entity/Entity';
import { TransformComponent } from '../entity/components/TransformComponent';
import { MeshComponent } from '../entity/components/MeshComponent';
import { PdfComponent } from '../entity/components/PdfComponent';

export interface PdfFloatingButtonsCallbacks {
  onPrev: (entityId: string) => void;
  onNext: (entityId: string) => void;
  // Open in overlay. Issue #8 wires a no-op stub; Issue #9 hooks the
  // per-viewer `PdfOverlayController`.
  onOpen: (entityId: string) => void;
}

export interface PdfFloatingButtonsUpdate {
  camera:         THREE.PerspectiveCamera;
  canvas:         HTMLElement;
  hoveredEntity:  Entity | null;
  selectedEntity: Entity | null;
}

const BTN_STYLE: Partial<CSSStyleDeclaration> = {
  position:       'fixed',
  pointerEvents:  'auto',
  background:     'rgba(20, 20, 28, 0.9)',
  color:          '#fff',
  border:         '1px solid rgba(255, 255, 255, 0.15)',
  borderRadius:   '4px',
  font:           '14px sans-serif',
  cursor:         'pointer',
  padding:        '4px 8px',
  zIndex:         '900',
  display:        'none',
  transform:      'translate(-50%, -50%)',
  userSelect:     'none',
};

const INDICATOR_STYLE: Partial<CSSStyleDeclaration> = {
  ...BTN_STYLE,
  background:     'rgba(20, 20, 28, 0.85)',
  cursor:         'default',
  pointerEvents:  'none',
  font:           '12px sans-serif',
};

export class PdfFloatingButtonsOverlay {
  private readonly prevBtn:   HTMLButtonElement;
  private readonly nextBtn:   HTMLButtonElement;
  private readonly openBtn:   HTMLButtonElement;
  private readonly indicator: HTMLDivElement;
  private readonly elements:  HTMLElement[];

  // Cache the entity id whose state we last rendered so we don't reflow
  // disabled flags / labels every frame when nothing changed.
  private lastEntityId:    string | null = null;
  private lastCurrentPage: number        = 0;
  private lastPageCount:   number        = 0;

  private readonly cb: PdfFloatingButtonsCallbacks;

  constructor(parent: HTMLElement, callbacks: PdfFloatingButtonsCallbacks) {
    this.cb = callbacks;

    this.prevBtn = document.createElement('button');
    Object.assign(this.prevBtn.style, BTN_STYLE);
    this.prevBtn.type = 'button';
    this.prevBtn.textContent = '‹';
    this.prevBtn.setAttribute('aria-label', 'Previous page');

    this.nextBtn = document.createElement('button');
    Object.assign(this.nextBtn.style, BTN_STYLE);
    this.nextBtn.type = 'button';
    this.nextBtn.textContent = '›';
    this.nextBtn.setAttribute('aria-label', 'Next page');

    this.openBtn = document.createElement('button');
    Object.assign(this.openBtn.style, BTN_STYLE);
    this.openBtn.type = 'button';
    this.openBtn.textContent = '⤢ Open';
    this.openBtn.setAttribute('aria-label', 'Open in overlay');

    this.indicator = document.createElement('div');
    Object.assign(this.indicator.style, INDICATOR_STYLE);

    this.prevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.lastEntityId) this.cb.onPrev(this.lastEntityId);
    });
    this.nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.lastEntityId) this.cb.onNext(this.lastEntityId);
    });
    this.openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.lastEntityId) this.cb.onOpen(this.lastEntityId);
    });

    this.elements = [this.prevBtn, this.nextBtn, this.openBtn, this.indicator];
    for (const el of this.elements) parent.appendChild(el);
  }

  update(input: PdfFloatingButtonsUpdate): void {
    const target = pickPdfTarget(input.hoveredEntity, input.selectedEntity);
    if (!target) {
      this.hide();
      return;
    }
    const pdf       = target.getComponent(PdfComponent)!;
    const mesh      = target.getComponent(MeshComponent);
    const transform = target.getComponent(TransformComponent);
    if (!mesh || !transform) {
      this.hide();
      return;
    }
    if (!pdf.state.assetSlug) {
      // PRD § Empty state: no slug → no buttons. Issue #12 polishes the
      // face-side empty treatment.
      this.hide();
      return;
    }
    const rect = input.canvas.getBoundingClientRect();
    const [hx, _hy, hz] = mesh.halfExtents();
    const matrix = transform.object3d.matrixWorld;

    const left  = projectLocalPoint(matrix, input.camera, rect, -hx, 0, 0);
    const right = projectLocalPoint(matrix, input.camera, rect,  hx, 0, 0);
    const top   = projectLocalPoint(matrix, input.camera, rect,   0, 0, -hz);
    const bot   = projectLocalPoint(matrix, input.camera, rect,   0, 0,  hz);

    // Behind the camera or fully behind the near plane → hide.
    if (!left || !right || !top || !bot) {
      this.hide();
      return;
    }

    const page  = pdf.state.currentPage;
    const total = pdf.pageCount();

    this.lastEntityId = target.id;
    if (this.lastCurrentPage !== page || this.lastPageCount !== total) {
      this.lastCurrentPage = page;
      this.lastPageCount   = total;
      this.indicator.textContent = total > 0 ? `${page} / ${total}` : `${page}`;
    }

    const atFirst = page <= 1;
    const atLast  = total > 0 && page >= total;
    setDisabled(this.prevBtn, atFirst);
    setDisabled(this.nextBtn, atLast);

    place(this.prevBtn,   left.x,   left.y);
    place(this.nextBtn,   right.x,  right.y);
    place(this.openBtn,   top.x,    top.y);
    place(this.indicator, bot.x,    bot.y);
  }

  hide(): void {
    this.lastEntityId    = null;
    this.lastCurrentPage = 0;
    this.lastPageCount   = 0;
    for (const el of this.elements) {
      if (el.style.display !== 'none') el.style.display = 'none';
    }
  }

  dispose(): void {
    for (const el of this.elements) el.remove();
  }
}

// Pick the PDF entity for which to show floating buttons. Hover wins
// over selection so the host can flip pages on a stack of PDF entities
// without having to re-select each.
function pickPdfTarget(hovered: Entity | null, selected: Entity | null): Entity | null {
  if (hovered && hovered.components.has('pdf'))   return hovered;
  if (selected && selected.components.has('pdf')) return selected;
  return null;
}

const projectVec = new THREE.Vector3();

function projectLocalPoint(
  matrixWorld: THREE.Matrix4,
  camera:      THREE.PerspectiveCamera,
  rect:        DOMRect,
  lx: number, ly: number, lz: number,
): { x: number; y: number } | null {
  projectVec.set(lx, ly, lz).applyMatrix4(matrixWorld).project(camera);
  if (projectVec.z <= -1 || projectVec.z >= 1) return null;
  const x = rect.left + (projectVec.x * 0.5 + 0.5) * rect.width;
  const y = rect.top  + (-projectVec.y * 0.5 + 0.5) * rect.height;
  return { x, y };
}

function place(el: HTMLElement, x: number, y: number): void {
  el.style.left = `${Math.round(x)}px`;
  el.style.top  = `${Math.round(y)}px`;
  if (el.style.display !== 'block') el.style.display = 'block';
}

function setDisabled(btn: HTMLButtonElement, disabled: boolean): void {
  if (btn.disabled === disabled) return;
  btn.disabled = disabled;
  btn.style.opacity = disabled ? '0.4' : '1';
  btn.style.cursor  = disabled ? 'not-allowed' : 'pointer';
}

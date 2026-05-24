// @vitest-environment jsdom
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import { AnchorLayout } from './AnchorLayout';
import { PdfOverlaySheet } from './PdfOverlaySheet';
import { PdfOverlayController } from './PdfOverlayController';
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

beforeEach(() => {
  assetService.setManifests([BASE_MANIFEST, PRIMITIVE_MANIFEST, Manifest.from([pdfEntry])]);
});

afterEach(() => {
  cleanup();
  assetService.setManifests([BASE_MANIFEST, PRIMITIVE_MANIFEST]);
});

function setup(initialPage = 1) {
  const controller = new PdfOverlayController();
  controller.open('custom:doc', initialPage);
  const ui = render(
    <AnchorLayout>
      <PdfOverlaySheet controller={controller} />
    </AnchorLayout>,
  );
  return { controller, ui };
}

describe('PdfOverlaySheet — render', () => {
  test('renders nothing when the controller is closed', () => {
    const controller = new PdfOverlayController();
    render(
      <AnchorLayout>
        <PdfOverlaySheet controller={controller} />
      </AnchorLayout>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('renders a dialog when open', () => {
    setup();
    expect(screen.getByRole('dialog')).not.toBeNull();
  });

  test('shows the asset slug + current page / total in the header', () => {
    setup(3);
    expect(screen.getByRole('dialog').textContent ?? '').toContain('custom:doc');
    expect(screen.getByRole('dialog').textContent ?? '').toContain('/ 5');
  });
});

describe('PdfOverlaySheet — nav controls', () => {
  test('Next/Prev arrows mutate controller.page (in-overlay only — entity untouched)', () => {
    const { controller } = setup(2);
    fireEvent.click(screen.getByLabelText('Next page'));
    expect(controller.getState()?.page).toBe(3);
    fireEvent.click(screen.getByLabelText('Previous page'));
    expect(controller.getState()?.page).toBe(2);
  });

  test('Prev disabled at page 1; Next disabled at last page', () => {
    const { controller } = setup(1);
    expect((screen.getByLabelText('Previous page') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Next page')     as HTMLButtonElement).disabled).toBe(false);

    act(() => { controller.setPage(5); });
    expect((screen.getByLabelText('Previous page') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText('Next page')     as HTMLButtonElement).disabled).toBe(true);
  });

  test('jump-to-page input clamps to [1, pageCount]', () => {
    const { controller } = setup(2);
    const input = screen.getByLabelText('Page') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(controller.getState()?.page).toBe(5);

    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(controller.getState()?.page).toBe(1);
  });

  test('non-integer jump-to-page input is rejected — page stays put', () => {
    const { controller } = setup(2);
    const input = screen.getByLabelText('Page') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(controller.getState()?.page).toBe(2);
  });
});

describe('PdfOverlaySheet — keyboard shortcuts', () => {
  function dialog(): HTMLElement { return screen.getByRole('dialog'); }

  test('Arrow keys / PgUp / PgDn flip the overlay page', () => {
    const { controller } = setup(2);
    fireEvent.keyDown(dialog(), { key: 'ArrowRight' });
    expect(controller.getState()?.page).toBe(3);
    fireEvent.keyDown(dialog(), { key: 'ArrowLeft' });
    expect(controller.getState()?.page).toBe(2);
    fireEvent.keyDown(dialog(), { key: 'PageDown' });
    expect(controller.getState()?.page).toBe(3);
    fireEvent.keyDown(dialog(), { key: 'PageUp' });
    expect(controller.getState()?.page).toBe(2);
  });

  test('Home / End jump to first / last page', () => {
    const { controller } = setup(3);
    fireEvent.keyDown(dialog(), { key: 'End' });
    expect(controller.getState()?.page).toBe(5);
    fireEvent.keyDown(dialog(), { key: 'Home' });
    expect(controller.getState()?.page).toBe(1);
  });

  test('keys do not fire when focus is in the page input', () => {
    const { controller } = setup(2);
    const input = screen.getByLabelText('Page') as HTMLInputElement;
    // jsdom bubbles the keydown to the dialog's onKeyDown — but our
    // handler bails when target is an INPUT.
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    expect(controller.getState()?.page).toBe(2);
  });

  test('keys do not fire when the dialog is not focused (separate document key)', () => {
    const { controller } = setup(2);
    // Sending a keydown at document level (not bubbled through the
    // dialog ref) is the simulator for "focus is elsewhere". Our
    // handler only attaches via React's onKeyDown on the dialog, so
    // a window-level keydown stays unobserved by it.
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(controller.getState()?.page).toBe(2);
  });
});

describe('PdfOverlaySheet — close', () => {
  test('X button closes', () => {
    const { controller } = setup();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(controller.getState()).toBeNull();
  });

  test('Escape closes (fires from window so it works regardless of focus)', () => {
    const { controller } = setup();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(controller.getState()).toBeNull();
  });
});

describe('PdfOverlaySheet — page sync from controller', () => {
  test('input value follows controller.setPage', () => {
    const { controller } = setup(2);
    const input = screen.getByLabelText('Page') as HTMLInputElement;
    expect(input.value).toBe('2');
    act(() => { controller.setPage(4); });
    expect((screen.getByLabelText('Page') as HTMLInputElement).value).toBe('4');
  });
});

describe('PdfOverlaySheet — drag-to-reposition', () => {
  function header(): HTMLElement {
    const sheet = screen.getByRole('dialog');
    const h = sheet.querySelector('header');
    if (!h) throw new Error('header not found');
    return h as HTMLElement;
  }

  // jsdom 25 doesn't implement PointerEvent, so RTL's fireEvent.pointerDown
  // can't carry clientX / button / pointerId through to the React
  // synthetic event. Dispatch a MouseEvent with the matching type so
  // React's onPointer* handlers fire with populated coords.
  function dispatchPointer(
    el: HTMLElement,
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    init: { clientX?: number; clientY?: number; button?: number; pointerId?: number },
  ): void {
    const ev = new MouseEvent(type, {
      bubbles: true, cancelable: true,
      clientX: init.clientX ?? 0,
      clientY: init.clientY ?? 0,
      button:  init.button  ?? 0,
    });
    Object.defineProperty(ev, 'pointerId', { value: init.pointerId ?? 1 });
    // pointer-capture stubs — jsdom doesn't ship them.
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    if (!proto.setPointerCapture)     proto.setPointerCapture     = () => {};
    if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};
    if (!proto.hasPointerCapture)     proto.hasPointerCapture     = () => false;
    act(() => { el.dispatchEvent(ev); });
  }

  function stubRect(left = 800, top = 200, width = 480, height = 600): void {
    const sheet = screen.getByRole('dialog');
    Object.defineProperty(sheet, 'getBoundingClientRect', {
      value: () => ({
        left, top, right: left + width, bottom: top + height,
        width, height, x: left, y: top, toJSON: () => ({}),
      }),
      configurable: true,
    });
  }

  test('default position uses the right-edge anchor (right: 16px)', () => {
    setup();
    const sheet = screen.getByRole('dialog');
    expect(sheet.style.right).toBe('16px');
    expect(sheet.style.left).toBe('');
  });

  test('pointer-drag on the header repositions the sheet via left/top', () => {
    setup();
    stubRect();
    const h = header();
    dispatchPointer(h, 'pointerdown', { clientX: 900, clientY: 220 });
    dispatchPointer(h, 'pointermove', { clientX: 700, clientY: 350 });
    dispatchPointer(h, 'pointerup',   { clientX: 700, clientY: 350 });
    const sheet = screen.getByRole('dialog');
    expect(sheet.style.left).toBe('600px');   // 800 + (700-900) = 600
    expect(sheet.style.top).toBe('330px');    // 200 + (350-220) = 330
    expect(sheet.style.right).toBe('auto');   // anchor's right override cleared
    expect(sheet.style.transform).toBe('none');
  });

  test('clicking the close button inside the header does not start a drag', () => {
    const { controller } = setup();
    dispatchPointer(screen.getByLabelText('Close'), 'pointerdown', { clientX: 10, clientY: 10 });
    expect(screen.getByRole('dialog').style.left).toBe('');
    fireEvent.click(screen.getByLabelText('Close'));
    expect(controller.getState()).toBeNull();
  });

  test('pointerdown on the nav buttons does not start a drag', () => {
    setup(2);
    dispatchPointer(screen.getByLabelText('Next page'), 'pointerdown', { clientX: 0, clientY: 0 });
    dispatchPointer(header(),                           'pointermove', { clientX: 50, clientY: 50 });
    dispatchPointer(header(),                           'pointerup',   { clientX: 50, clientY: 50 });
    expect(screen.getByRole('dialog').style.left).toBe('');
  });

  test('drag clamps so the sheet keeps at least 40px visible on each edge', () => {
    setup();
    stubRect();
    const h = header();
    dispatchPointer(h, 'pointerdown', { clientX: 900,    clientY: 220 });
    dispatchPointer(h, 'pointermove', { clientX: -10000, clientY: -10000 });
    const sheet = screen.getByRole('dialog');
    // Width 480, minVisible 40 → leftmost allowed = 40 - 480 = -440.
    expect(Number(sheet.style.left.replace('px', ''))).toBeGreaterThanOrEqual(-440);
    expect(Number(sheet.style.top.replace('px',  ''))).toBeGreaterThanOrEqual(0);
  });
});

describe('PdfOverlaySheet — text layer', () => {
  test('stamps the text-layer stylesheet into the document', () => {
    setup();
    const styles = document.querySelectorAll('style');
    let found = false;
    for (const s of styles) {
      if ((s.textContent ?? '').includes('.pdf-overlay-text-layer')) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});

describe('PdfOverlaySheet — singleton swap', () => {
  test('opening a second slug replaces sheet content', () => {
    const otherEntry: AssetEntry = { ...pdfEntry, slug: 'custom:other', pageCount: 2 };
    assetService.setManifests([
      BASE_MANIFEST, PRIMITIVE_MANIFEST,
      Manifest.from([pdfEntry, otherEntry]),
    ]);
    const controller = new PdfOverlayController();
    controller.open('custom:doc', 3);
    render(
      <AnchorLayout>
        <PdfOverlaySheet controller={controller} />
      </AnchorLayout>,
    );
    expect(screen.getByRole('dialog').textContent ?? '').toContain('custom:doc');
    act(() => { controller.open('custom:other', 1); });
    expect(screen.getByRole('dialog').textContent ?? '').toContain('custom:other');
    expect(screen.getByRole('dialog').textContent ?? '').toContain('/ 2');
  });
});

// Silence unused-vars: vi is imported to mirror the Inspect dialog test
// file's pattern.
void vi;

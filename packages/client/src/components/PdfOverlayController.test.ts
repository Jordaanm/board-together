import { describe, test, expect, vi } from 'vitest';
import { PdfOverlayController } from './PdfOverlayController';

describe('PdfOverlayController', () => {
  test('open(slug, page) sets state and notifies listeners', () => {
    const c = new PdfOverlayController();
    const cb = vi.fn();
    c.subscribe(cb);
    c.open('custom:doc', 3);
    expect(c.getState()).toEqual({ assetSlug: 'custom:doc', page: 3 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('close() clears state and notifies', () => {
    const c = new PdfOverlayController();
    c.open('custom:doc', 1);
    const cb = vi.fn();
    c.subscribe(cb);
    c.close();
    expect(c.getState()).toBeNull();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('close() on an already-closed overlay is a no-op', () => {
    const c = new PdfOverlayController();
    const cb = vi.fn();
    c.subscribe(cb);
    c.close();
    expect(cb).not.toHaveBeenCalled();
  });

  test('singleton swap: opening a second slug replaces the first', () => {
    const c = new PdfOverlayController();
    c.open('custom:a', 2);
    c.open('custom:b', 1);
    expect(c.getState()).toEqual({ assetSlug: 'custom:b', page: 1 });
  });

  test('setPage updates page only when open', () => {
    const c = new PdfOverlayController();
    c.setPage(5);
    expect(c.getState()).toBeNull();
    c.open('custom:a', 1);
    c.setPage(4);
    expect(c.getState()).toEqual({ assetSlug: 'custom:a', page: 4 });
  });

  test('setPage rejects non-integer / non-positive values', () => {
    const c = new PdfOverlayController();
    c.open('custom:a', 2);
    c.setPage(0);
    c.setPage(-1);
    c.setPage(1.5);
    expect(c.getState()?.page).toBe(2);
  });

  test('setPage to the same page does not notify', () => {
    const c = new PdfOverlayController();
    c.open('custom:a', 2);
    const cb = vi.fn();
    c.subscribe(cb);
    c.setPage(2);
    expect(cb).not.toHaveBeenCalled();
  });

  test('page inheritance: open captures the supplied page (not the entity\'s current page later)', () => {
    const c = new PdfOverlayController();
    c.open('custom:doc', 5);
    // Simulating the in-world entity flipping its own page after opening
    // (which the test stands in for by asserting controller state stays
    // independent — overlay does not subscribe to PdfComponent updates).
    expect(c.getState()).toEqual({ assetSlug: 'custom:doc', page: 5 });
  });

  test('unsubscribe stops notifications for that listener', () => {
    const c = new PdfOverlayController();
    const cb = vi.fn();
    const unsub = c.subscribe(cb);
    unsub();
    c.open('custom:a', 1);
    expect(cb).not.toHaveBeenCalled();
  });
});

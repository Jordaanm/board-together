// Per-viewer "Open in Overlay" state holder. Singleton — opening for a
// second PDF replaces the first rather than stacking. State is local-
// only (never replicated), so each viewer's overlay is independent.

export interface PdfOverlayOpen {
  assetSlug: string;
  page:      number;
}

export type PdfOverlayState = PdfOverlayOpen | null;

export class PdfOverlayController {
  private state:     PdfOverlayState   = null;
  private listeners = new Set<() => void>();

  open(slug: string, page: number): void {
    if (!slug)                           return;
    if (!Number.isInteger(page) || page < 1) return;
    this.state = { assetSlug: slug, page };
    this.notify();
  }

  close(): void {
    if (this.state === null) return;
    this.state = null;
    this.notify();
  }

  setPage(n: number): void {
    if (!this.state) return;
    if (!Number.isInteger(n) || n < 1) return;
    if (this.state.page === n) return;
    this.state = { ...this.state, page: n };
    this.notify();
  }

  getState(): PdfOverlayState {
    return this.state;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }
}

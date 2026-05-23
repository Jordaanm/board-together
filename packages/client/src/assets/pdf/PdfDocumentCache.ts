// Per-slug cache of opened `PDFDocumentProxy` handles.
//
// Concurrent `getDocument(slug, …)` calls share one in-flight load — the
// second caller awaits the same promise. After `release(slug)` the entry
// is dropped and the next call re-fetches. Bytes are taken from the
// AssetService → BundleStore chain; this module never owns the bytes.

import type { PDFDocumentProxy } from 'pdfjs-dist';
import { loadPdfjs, type Pdfjs } from './pdfjsLoader';

export interface PdfDocumentCacheOptions {
  pdfjsLoader?: () => Promise<Pdfjs>;
}

export class PdfDocumentCache {
  private readonly loader: () => Promise<Pdfjs>;
  private readonly entries = new Map<string, Promise<PDFDocumentProxy>>();

  constructor(opts: PdfDocumentCacheOptions = {}) {
    this.loader = opts.pdfjsLoader ?? loadPdfjs;
  }

  getDocument(slug: string, bytes: Uint8Array): Promise<PDFDocumentProxy> {
    const existing = this.entries.get(slug);
    if (existing) return existing;
    const promise = this.loader().then((p) => p.getDocument({ data: bytes }).promise);
    this.entries.set(slug, promise);
    // If the load fails, drop the entry so a retry isn't stuck on a
    // permanently-rejected promise.
    promise.catch(() => {
      if (this.entries.get(slug) === promise) this.entries.delete(slug);
    });
    return promise;
  }

  release(slug: string): void {
    this.entries.delete(slug);
  }

  has(slug: string): boolean {
    return this.entries.has(slug);
  }
}

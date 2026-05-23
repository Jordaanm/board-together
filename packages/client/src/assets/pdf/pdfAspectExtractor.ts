// Upload-time metadata extractor for uploaded PDFs.
//
// Returns page-1 aspect ratio (so spawned entities can size their depth
// without re-parsing the PDF) and total page count (so the bounds
// clamping in `PdfComponent.setPage` and the page indicator in the
// floating buttons can read it from the manifest).
//
// Loads pdfjs through the same dynamic-import seam as `PdfDocumentCache`;
// tests inject a fake loader and never run real pdfjs.

import { loadPdfjs, type Pdfjs } from './pdfjsLoader';

export interface PdfMetadata {
  aspectRatio: number;
  pageCount:   number;
}

export interface ExtractAspectOptions {
  pdfjsLoader?: () => Promise<Pdfjs>;
}

export async function extractPdfMetadata(
  bytes: Uint8Array,
  opts: ExtractAspectOptions = {},
): Promise<PdfMetadata> {
  const loader = opts.pdfjsLoader ?? loadPdfjs;
  const pdfjs  = await loader();
  const doc    = await pdfjs.getDocument({ data: bytes }).promise;
  const page   = await doc.getPage(1);
  const vp     = page.getViewport({ scale: 1 });
  if (!Number.isFinite(vp.width) || !Number.isFinite(vp.height) || vp.height <= 0 || vp.width <= 0) {
    throw new Error(`extractPdfMetadata: invalid page-1 dimensions (${vp.width} × ${vp.height})`);
  }
  const pageCount = doc.numPages;
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error(`extractPdfMetadata: invalid page count (${pageCount})`);
  }
  return { aspectRatio: vp.width / vp.height, pageCount };
}

// Back-compat alias retained for Issue #6's contract. New callers should
// prefer extractPdfMetadata so they receive pageCount too.
export async function extractAspect(
  bytes: Uint8Array,
  opts: ExtractAspectOptions = {},
): Promise<number> {
  return (await extractPdfMetadata(bytes, opts)).aspectRatio;
}

// Page-1 dimensions extractor for uploaded PDFs.
//
// Used at upload time so the manifest entry can store an
// `aspectRatio = width / height`. Spawned PDF entities read it to size
// their initial depth proportionally to width without re-parsing the
// PDF on every spawn.
//
// Loads pdfjs through the same dynamic-import seam as `PdfDocumentCache`;
// tests inject a fake loader and never run real pdfjs.

import { loadPdfjs, type Pdfjs } from './pdfjsLoader';

export interface ExtractAspectOptions {
  pdfjsLoader?: () => Promise<Pdfjs>;
}

export async function extractAspect(
  bytes: Uint8Array,
  opts: ExtractAspectOptions = {},
): Promise<number> {
  const loader = opts.pdfjsLoader ?? loadPdfjs;
  const pdfjs  = await loader();
  const doc    = await pdfjs.getDocument({ data: bytes }).promise;
  const page   = await doc.getPage(1);
  const vp     = page.getViewport({ scale: 1 });
  if (!Number.isFinite(vp.width) || !Number.isFinite(vp.height) || vp.height <= 0 || vp.width <= 0) {
    throw new Error(`extractAspect: invalid page-1 dimensions (${vp.width} × ${vp.height})`);
  }
  return vp.width / vp.height;
}

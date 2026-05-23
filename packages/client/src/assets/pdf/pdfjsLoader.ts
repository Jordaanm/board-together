// Single dynamic-import seam for pdfjs-dist. Imports stay behind a
// runtime `import()` so static analysis (and the production bundler)
// keeps pdfjs out of the main chunk — non-PDF rooms never pay for it.
//
// The worker is vendored via Vite's `?worker&url` query so it ships
// same-origin alongside the app bundle (no CDN requests at runtime).

import type * as PdfjsType from 'pdfjs-dist';

export type Pdfjs = typeof PdfjsType;

let pdfjsPromise: Promise<Pdfjs> | null = null;

export function loadPdfjs(): Promise<Pdfjs> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const [pdfjs, workerUrl] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.mjs?worker&url'),
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

// Test hook — lets a unit test discard a partly-initialised state
// between cases. Production code never calls this.
export function __resetPdfjsLoaderForTests(): void {
  pdfjsPromise = null;
}

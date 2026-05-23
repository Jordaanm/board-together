import { describe, test, expect } from 'vitest';
import { extractAspect, extractPdfMetadata } from './pdfAspectExtractor';
import type { Pdfjs } from './pdfjsLoader';

function makeFakePdfjs(
  width: number, height: number,
  opts: { rejectGet?: boolean; pageCount?: number } = {},
): Pdfjs {
  const pageCount = opts.pageCount ?? 1;
  return {
    getDocument: () => ({
      promise: opts.rejectGet
        ? Promise.reject(new Error('bad pdf'))
        : Promise.resolve({
            numPages: pageCount,
            getPage:  () => Promise.resolve({
              getViewport: () => ({ width, height }),
            }),
          }),
    }),
    GlobalWorkerOptions: { workerSrc: '' },
  } as unknown as Pdfjs;
}

describe('extractAspect', () => {
  test('returns width / height from page 1 viewport at scale 1', async () => {
    const pdfjs = makeFakePdfjs(612, 792);     // US Letter at 72 DPI
    const aspect = await extractAspect(new Uint8Array([1, 2, 3]), {
      pdfjsLoader: () => Promise.resolve(pdfjs),
    });
    expect(aspect).toBeCloseTo(612 / 792);
  });

  test('rejects when pdfjs cannot parse the bytes', async () => {
    const pdfjs = makeFakePdfjs(0, 0, { rejectGet: true });
    await expect(extractAspect(new Uint8Array([0]), {
      pdfjsLoader: () => Promise.resolve(pdfjs),
    })).rejects.toThrow(/bad pdf/);
  });

  test('rejects on zero / negative / non-finite dimensions', async () => {
    for (const [w, h] of [[0, 100], [100, 0], [-1, 100], [100, NaN]]) {
      const pdfjs = makeFakePdfjs(w, h);
      await expect(extractAspect(new Uint8Array([0]), {
        pdfjsLoader: () => Promise.resolve(pdfjs),
      })).rejects.toThrow(/dimensions/);
    }
  });
});

describe('extractPdfMetadata', () => {
  test('returns aspect + page count', async () => {
    const pdfjs = makeFakePdfjs(612, 792, { pageCount: 17 });
    const meta = await extractPdfMetadata(new Uint8Array([1, 2, 3]), {
      pdfjsLoader: () => Promise.resolve(pdfjs),
    });
    expect(meta.aspectRatio).toBeCloseTo(612 / 792);
    expect(meta.pageCount).toBe(17);
  });

  test('rejects on non-positive page count', async () => {
    const pdfjs = makeFakePdfjs(612, 792, { pageCount: 0 });
    await expect(extractPdfMetadata(new Uint8Array([0]), {
      pdfjsLoader: () => Promise.resolve(pdfjs),
    })).rejects.toThrow(/page count/);
  });
});

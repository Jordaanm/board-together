import { describe, test, expect, vi } from 'vitest';
import { PdfDocumentCache } from './PdfDocumentCache';
import type { Pdfjs } from './pdfjsLoader';

// Minimal fake pdfjs at the loader seam. `getDocument` returns an
// opaque doc object whose identity we check; concurrent calls share
// the same in-flight promise.
function makeFakePdfjs(): {
  pdfjs: Pdfjs;
  calls: { byteLength: number }[];
  next: (slug: string) => void;
} {
  const calls: { byteLength: number }[] = [];
  let counter = 0;
  const pdfjs = {
    getDocument: ({ data }: { data: Uint8Array }) => {
      const id = ++counter;
      calls.push({ byteLength: (data as Uint8Array).byteLength });
      const promise = Promise.resolve({ __doc: id });
      return { promise };
    },
    GlobalWorkerOptions: { workerSrc: '' },
  } as unknown as Pdfjs;
  return { pdfjs, calls, next: () => {} };
}

describe('PdfDocumentCache', () => {
  test('two concurrent getDocument calls share one document instance', async () => {
    const { pdfjs, calls } = makeFakePdfjs();
    const cache = new PdfDocumentCache({ pdfjsLoader: () => Promise.resolve(pdfjs) });
    const a = cache.getDocument('custom:foo', new Uint8Array([1, 2, 3]));
    const b = cache.getDocument('custom:foo', new Uint8Array([1, 2, 3]));
    const [docA, docB] = await Promise.all([a, b]);
    expect(docA).toBe(docB);
    expect(calls.length).toBe(1);
  });

  test('release(slug) drops the entry; a subsequent getDocument re-fetches', async () => {
    const { pdfjs, calls } = makeFakePdfjs();
    const cache = new PdfDocumentCache({ pdfjsLoader: () => Promise.resolve(pdfjs) });
    const docA = await cache.getDocument('custom:foo', new Uint8Array([1]));
    cache.release('custom:foo');
    const docB = await cache.getDocument('custom:foo', new Uint8Array([1]));
    expect(docA).not.toBe(docB);
    expect(calls.length).toBe(2);
  });

  test('different slugs do not share entries', async () => {
    const { pdfjs, calls } = makeFakePdfjs();
    const cache = new PdfDocumentCache({ pdfjsLoader: () => Promise.resolve(pdfjs) });
    const docA = await cache.getDocument('custom:a', new Uint8Array([1]));
    const docB = await cache.getDocument('custom:b', new Uint8Array([1]));
    expect(docA).not.toBe(docB);
    expect(calls.length).toBe(2);
  });

  test('a failed load is not cached — retry refetches', async () => {
    let attempts = 0;
    const pdfjs = {
      getDocument: () => {
        attempts++;
        if (attempts === 1) {
          return { promise: Promise.reject(new Error('boom')) };
        }
        return { promise: Promise.resolve({ __doc: 'ok' }) };
      },
      GlobalWorkerOptions: { workerSrc: '' },
    } as unknown as Pdfjs;
    const cache = new PdfDocumentCache({ pdfjsLoader: () => Promise.resolve(pdfjs) });
    await expect(cache.getDocument('custom:foo', new Uint8Array([1]))).rejects.toThrow(/boom/);
    // Yield so the catch handler can clear the entry.
    await Promise.resolve();
    await Promise.resolve();
    const ok = await cache.getDocument('custom:foo', new Uint8Array([1]));
    expect(ok).toEqual({ __doc: 'ok' });
    expect(attempts).toBe(2);
  });

  test('does not load pdfjs until getDocument is called', () => {
    const loader = vi.fn(() => Promise.resolve({} as unknown as Pdfjs));
    new PdfDocumentCache({ pdfjsLoader: loader });
    expect(loader).not.toHaveBeenCalled();
  });
});

// Pure pdf-ref grammar. Mirrors spriteRef.ts.
//
// A 2-segment slug (`custom:foo`) addresses a pdf entry in the Manifest.
// A pdf-ref (`pdf:custom:foo/page/3`) is *synthetic* — it identifies page N
// of that pdf and is never stored as its own Manifest entry. The leading
// `pdf:` prefix distinguishes it from regular slugs so AssetService can
// route it through the PDF rendering pipeline.

import { isSlug } from './Manifest';

export interface ParsedPdfRef {
  slug: string;
  page: number;
}

const PAGE_RE = /^[1-9][0-9]*$/;

export function parsePdfRef(ref: unknown): ParsedPdfRef | null {
  if (typeof ref !== 'string' || ref.length === 0) return null;
  if (!ref.startsWith('pdf:')) return null;
  const tail = ref.slice(4);
  const idx  = tail.indexOf('/page/');
  if (idx === -1) return null;
  const slug     = tail.slice(0, idx);
  const pageStr  = tail.slice(idx + '/page/'.length);
  if (!isSlug(slug)) return null;
  if (!PAGE_RE.test(pageStr)) return null;
  const page = Number(pageStr);
  if (!Number.isInteger(page) || page <= 0) return null;
  return { slug, page };
}

export function formatPdfRef(slug: string, page: number): string {
  if (!Number.isInteger(page) || page <= 0) {
    throw new Error(`formatPdfRef: page must be a positive integer, got ${page}`);
  }
  return `pdf:${slug}/page/${page}`;
}

export function isPdfRef(ref: string): boolean {
  return parsePdfRef(ref) !== null;
}

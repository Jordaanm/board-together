// Renders a single PDF page to a CanvasTexture at a given scale.
// Stateless — the caller (typically AssetService) decides when to render
// and what to do with the result; this module just does the draw.

import * as THREE from 'three';
import type { PDFDocumentProxy } from 'pdfjs-dist';

export async function renderPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  scale: number,
): Promise<THREE.CanvasTexture> {
  const page     = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas   = document.createElement('canvas');
  canvas.width   = Math.ceil(viewport.width);
  canvas.height  = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('PdfPageRenderer: 2d context unavailable');
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

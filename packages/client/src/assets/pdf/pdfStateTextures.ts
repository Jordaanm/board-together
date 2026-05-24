// Procedural state textures painted onto the `prim:page` face when the
// PDF entity is in the "empty" non-happy state. Pending and broken
// states keep the standard magenta `getImagePlaceholder` — their
// callouts ("Loading…", "PDF unavailable") render as DOM badges on top
// of the in-world entity, mirroring the floating-button overlay.

import * as THREE from 'three';

const EMPTY_W = 512;
const EMPTY_H = 660;   // ~ letter aspect (8.5 × 11)

let emptyTexture: THREE.Texture | null = null;

export function getPdfEmptyPlaceholder(): THREE.Texture {
  if (emptyTexture) return emptyTexture;
  if (typeof document === 'undefined') {
    const data = new Uint8Array([255, 255, 255, 255]);
    const tex  = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    tex.colorSpace  = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    emptyTexture = tex;
    return tex;
  }
  const canvas = document.createElement('canvas');
  canvas.width  = EMPTY_W;
  canvas.height = EMPTY_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    const data = new Uint8Array([255, 255, 255, 255]);
    const fallback = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    fallback.colorSpace  = THREE.SRGBColorSpace;
    fallback.needsUpdate = true;
    emptyTexture = fallback;
    return fallback;
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, EMPTY_W, EMPTY_H);
  ctx.strokeStyle = '#d8d8d8';
  ctx.lineWidth   = 2;
  ctx.strokeRect(8, 8, EMPTY_W - 16, EMPTY_H - 16);
  ctx.fillStyle    = '#888';
  ctx.font         = 'bold 36px sans-serif';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('No PDF assigned', EMPTY_W / 2, EMPTY_H / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  emptyTexture = tex;
  return tex;
}

// Synthetic URL recognised by AssetService — analogous to
// `placeholder://image` but routed to the empty-state texture.
export const PDF_EMPTY_PLACEHOLDER_URL = 'placeholder://pdf/empty';

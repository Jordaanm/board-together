// Resolve an arbitrary image ref (URL, data URL, manifest slug, bundled-asset
// slug, or sprite ref `sheet:body:index`) into a CSS-loadable source URL.
//
// Subscribes through `assetService.subscribe(ref, 'image', ...)` so every
// ref kind goes through the same resolution chain that the 3D mesh path
// uses. Sprite refs return a freshly-cropped data URL; everything else
// returns the underlying HTMLImageElement.src verbatim.

import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { assetService } from './AssetService';

export function useImageRefSrc(ref: string): string {
  const [src, setSrc] = useState<string>('');

  useEffect(() => {
    if (!ref) { setSrc(''); return; }
    let cancelled = false;
    const unsub = assetService.subscribe(ref, 'image', (tex, status) => {
      if (cancelled) return;
      if (status !== 'loaded') return;
      const resolved = textureToSrc(tex);
      setSrc(resolved);
    });
    return () => { cancelled = true; unsub(); };
  }, [ref]);

  return src;
}

// Turn a THREE.Texture into something CSS / <img> can render. Sprite slices
// (offset/repeat != identity) are baked into a canvas; flat images return
// their source URL directly.
function textureToSrc(tex: THREE.Texture): string {
  const img = tex.image as HTMLImageElement | HTMLCanvasElement | ImageBitmap | undefined;
  if (!img) return '';
  const repeatX = tex.repeat.x;
  const repeatY = tex.repeat.y;
  const isSlice = repeatX < 0.9999 || repeatY < 0.9999;
  if (!isSlice && img instanceof HTMLImageElement) {
    return img.src;
  }
  const w = (img as HTMLImageElement).naturalWidth  ?? (img as HTMLCanvasElement).width  ?? (img as ImageBitmap).width;
  const h = (img as HTMLImageElement).naturalHeight ?? (img as HTMLCanvasElement).height ?? (img as ImageBitmap).height;
  if (!w || !h) return img instanceof HTMLImageElement ? img.src : '';
  const sx  = tex.offset.x * w;
  const sy  = (1 - tex.offset.y - repeatY) * h;
  const sw  = repeatX * w;
  const sh  = repeatY * h;
  const canvas = document.createElement('canvas');
  canvas.width  = Math.max(1, Math.round(sw));
  canvas.height = Math.max(1, Math.round(sh));
  const cx = canvas.getContext('2d');
  if (!cx) return img instanceof HTMLImageElement ? img.src : '';
  cx.drawImage(img as CanvasImageSource, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL();
}

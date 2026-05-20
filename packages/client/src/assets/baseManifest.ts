// Base + primitive manifests baked into the client bundle. Issue #2 of
// issues--asset-registry.md.
//
// `BASE_MANIFEST` carries the type-default placeholders (`base:placeholder/*`).
// Their `url` is a synthetic `placeholder://*` marker that AssetService
// recognises and short-circuits to the in-code placeholder asset.
//
// `PRIMITIVE_MANIFEST` exposes the in-code primitive meshes as catalog
// entries. Their `url` is a `primitive://*` marker; primitives are interpreted
// directly by `MeshComponent.buildMesh` via `meshRef`, so the marker is never
// fed to a network loader.

import { Manifest, type AssetEntry } from './Manifest';
import skydomeDefaultUrl from './skydome.png';
import tableDefaultUrl from './wood.jpg';
import bagDefaultUrl from './bag.glb';

export const DEFAULT_SKY_SLUG = 'base:sky/default';
export const DEFAULT_TABLE_SLUG = 'base:table/default';
export const DEFAULT_BAG_SLUG = 'base:bag/default';

export const BASE_MANIFEST_ENTRIES: AssetEntry[] = [
  { slug: 'base:placeholder/image', name: 'Image placeholder', type: 'image', url: 'placeholder://image', preload: false },
  { slug: 'base:placeholder/model', name: 'Model placeholder', type: 'model', url: 'placeholder://model', preload: false },
  { slug: 'base:placeholder/sound', name: 'Sound placeholder', type: 'sound', url: 'placeholder://sound', preload: false },
  { slug: DEFAULT_SKY_SLUG,         name: 'Default sky',       type: 'image', url: skydomeDefaultUrl,     preload: true  },
  { slug: DEFAULT_TABLE_SLUG,       name: 'Default table',     type: 'image', url: tableDefaultUrl,       preload: true  },
  // Leather pouch — issue #5 of issues--bag.md. The GLB carries its own
  // authored materials (diffuse colour + bake), and MeshComponent does not
  // apply `textureRefs` to loaded GLTF models, so no separate diffuse-PNG
  // entry is registered. GLB sits at ~640 KB — slightly over the 500 KB
  // bundle guideline, accepted for v1 because no separate diffuse asset
  // ships alongside.
  { slug: DEFAULT_BAG_SLUG,         name: 'Default bag',       type: 'model', url: bagDefaultUrl,         preload: true  },
];

export const PRIMITIVE_MANIFEST_ENTRIES: AssetEntry[] = [
  { slug: 'prim:cube',         name: 'Cube',         type: 'model', url: 'primitive://cube',         preload: true },
  { slug: 'prim:d6',           name: 'D6',           type: 'model', url: 'primitive://d6',           preload: true },
  { slug: 'prim:d20',          name: 'D20',          type: 'model', url: 'primitive://d20',          preload: true },
  { slug: 'prim:card',         name: 'Card',         type: 'model', url: 'primitive://card',         preload: true },
  { slug: 'prim:deck',         name: 'Deck',         type: 'model', url: 'primitive://deck',         preload: true },
  { slug: 'prim:meeple',       name: 'Meeple',       type: 'model', url: 'primitive://meeple',       preload: true },
  { slug: 'prim:table-rect',   name: 'Table (rect)', type: 'model', url: 'primitive://table-rect',   preload: true },
  { slug: 'prim:table-circle', name: 'Table (round)', type: 'model', url: 'primitive://table-circle', preload: true },
  { slug: 'prim:disc',         name: 'Disc',         type: 'model', url: 'primitive://disc',         preload: true },
];

export const BASE_MANIFEST      = Manifest.from(BASE_MANIFEST_ENTRIES);
export const PRIMITIVE_MANIFEST = Manifest.from(PRIMITIVE_MANIFEST_ENTRIES);

export const PLACEHOLDER_IMAGE_SLUG = 'base:placeholder/image';
export const PLACEHOLDER_MODEL_SLUG = 'base:placeholder/model';
export const PLACEHOLDER_SOUND_SLUG = 'base:placeholder/sound';

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { type AssetEntry, type AssetType, isSlug, Manifest } from './Manifest';
import { parseRef } from './spriteRef';
import { spriteUV } from './spriteUV';
import { parsePdfRef } from './pdfRef';
import { BASE_MANIFEST, PRIMITIVE_MANIFEST } from './baseManifest';
import type { BundleStore } from './BundleStore';
import type { BundleCache } from './BundleCache';
import type { BundleTransport } from './BundleTransport';
import { PdfDocumentCache } from './pdf/PdfDocumentCache';
import { PdfRenderCache } from './pdf/PdfRenderCache';
import { renderPage as defaultPdfPageRenderer } from './pdf/PdfPageRenderer';
import { getPdfEmptyPlaceholder, PDF_EMPTY_PLACEHOLDER_URL } from './pdf/pdfStateTextures';
import type { PDFDocumentProxy } from 'pdfjs-dist';

// Single scale used for in-world PDF page renders. Overlay (Issue #9)
// will render at a higher scale through a separate path; this constant
// is private to the in-world resolution.
const PDF_RENDER_SCALE = 1.5;

export type PdfPageRendererFn = (
  doc: PDFDocumentProxy, page: number, scale: number,
) => Promise<THREE.CanvasTexture>;

// Single funnel for asset loads. Issues #1, #2, and #9 of
// issues--asset-registry.md.
//
// `subscribe(ref, type, listener)` returns the current cached state to the
// listener immediately (placeholder until the real asset arrives) and again on
// every transition. Internal cache dedups concurrent + repeat fetches by ref.
// Loaders are injected via constructor so tests can drive them deterministically.
//
// Refs may be either raw URLs or namespaced slugs (`base:`, `custom:`,
// `prim:`). Slugs are resolved through the configured manifests; unknown
// slugs and type mismatches fall back to `base:placeholder/<type>` and report
// `broken` status so the manager UI can flag them.
//
// `placeholder://*` and `primitive://*` are synthetic URL markers — they
// never hit the network; AssetService recognises them and short-circuits to
// the in-code placeholder. Primitive meshes still render through
// `MeshComponent.buildMesh` directly via `meshRef`.
//
// Model assets surface a canonical THREE.Object3D in the cache; consumers are
// responsible for `obj.clone(true)` before adding it to a scene graph (Three's
// parent-child relationship allows only one parent at a time).

export type { AssetType };
export type AssetStatus = 'pending' | 'loaded' | 'broken';

export type ImageLoader = (url: string) => Promise<THREE.Texture>;
export type ModelLoader = (url: string) => Promise<THREE.Object3D>;
export type SoundLoader = (url: string) => Promise<AudioBuffer>;

const defaultImageLoader: ImageLoader = (url) => {
  if (typeof Image === 'undefined') {
    return Promise.reject(new Error('no DOM available for image load'));
  }
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        // PNG/JPEG pixels are sRGB-encoded; three r155+ defaults loaded
        // textures to LinearSRGBColorSpace which skips the sRGB→linear decode
        // and renders ~washed-out. Tagging here covers every consumer that
        // pipes a texture from AssetService into `material.map`.
        tex.colorSpace = THREE.SRGBColorSpace;
        resolve(tex);
      },
      undefined,
      () => reject(new Error(`failed to load image: ${url}`)),
    );
  });
};

const defaultModelLoader: ModelLoader = (url) => {
  if (typeof Image === 'undefined') {
    return Promise.reject(new Error('no DOM available for model load'));
  }
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(
      url,
      (gltf) => resolve(gltf.scene),
      undefined,
      () => reject(new Error(`failed to load model: ${url}`)),
    );
  });
};

let sharedAudioContext: AudioContext | null = null;
function getAudioContext(): AudioContext | null {
  if (sharedAudioContext) return sharedAudioContext;
  const Ctor = typeof AudioContext !== 'undefined'
    ? AudioContext
    : (typeof window !== 'undefined' && (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) || null;
  if (!Ctor) return null;
  sharedAudioContext = new Ctor();
  return sharedAudioContext;
}

const defaultSoundLoader: SoundLoader = async (url) => {
  const ctx = getAudioContext();
  if (!ctx) throw new Error('no AudioContext available for sound load');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch sound: ${url} — ${res.status}`);
  const buf = await res.arrayBuffer();
  return await ctx.decodeAudioData(buf);
};

let placeholderImage: THREE.Texture | null = null;

// Selects the right placeholder texture for a synthetic `placeholder://`
// URL. The default magenta is returned for unknown placeholders so the
// existing `placeholder://image` flow stays unchanged.
function placeholderTextureFor(url: string): THREE.Texture {
  if (url === PDF_EMPTY_PLACEHOLDER_URL) return getPdfEmptyPlaceholder();
  return getImagePlaceholder();
}

export function getImagePlaceholder(): THREE.Texture {
  if (placeholderImage) return placeholderImage;
  const data = new Uint8Array([255, 0, 255, 255]);
  const tex  = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  tex.colorSpace  = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  placeholderImage = tex;
  return tex;
}

let placeholderModel: THREE.Object3D | null = null;

// Canonical placeholder Object3D — a small magenta cube. Consumers MUST
// `clone(true)` before adding to a scene graph, otherwise re-parenting will
// silently move the placeholder away from previous consumers.
export function getModelPlaceholder(): THREE.Object3D {
  if (placeholderModel) return placeholderModel;
  const geometry = new THREE.BoxGeometry(0.2, 0.2, 0.2);
  const material = new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true });
  const mesh     = new THREE.Mesh(geometry, material);
  placeholderModel = mesh;
  return mesh;
}

type ImageListener = (texture: THREE.Texture, status: AssetStatus) => void;
type ModelListener = (object: THREE.Object3D, status: AssetStatus) => void;
// Sound listeners receive `null` while the buffer is pending or broken — no
// silent-buffer placeholder exists because constructing one needs a live
// AudioContext (unavailable in headless tests). Callers that want to play
// must check `status === 'loaded'` and `buffer !== null`.
type SoundListener = (buffer: AudioBuffer | null, status: AssetStatus) => void;

interface ImageEntry {
  status:      AssetStatus;
  texture:     THREE.Texture;
  listeners:   Set<ImageListener>;
  loadPromise: Promise<THREE.Texture>;
  // Set only when this entry is a 3-segment sprite ref. Used by
  // `invalidateSheet` to refire dependent sprites on grid/URL changes.
  sheetSlug?:  string;
  // Set during a bundled-asset wire pull; cleared on resolve/reject.
  // unsubscribe() calls this when the listener count drops to zero so
  // background fetches stop when nothing is listening.
  cancelWirePull?: () => void;
}

type SheetStatusListener = (status: AssetStatus) => void;

interface SheetEntry {
  status:      AssetStatus;
  texture:     THREE.Texture | null;
  loadPromise: Promise<THREE.Texture | null>;
  listeners:   Set<SheetStatusListener>;
}

interface ModelEntry {
  status:      AssetStatus;
  object3d:    THREE.Object3D;
  listeners:   Set<ModelListener>;
  loadPromise: Promise<THREE.Object3D>;
  cancelWirePull?: () => void;
}

interface SoundEntry {
  status:      AssetStatus;
  buffer:      AudioBuffer | null;
  listeners:   Set<SoundListener>;
  loadPromise: Promise<AudioBuffer | null>;
  cancelWirePull?: () => void;
}

export interface AssetServiceOptions {
  imageLoader?:     ImageLoader;
  modelLoader?:     ModelLoader;
  soundLoader?:     SoundLoader;
  manifests?:       Manifest[];
  // Optional content-addressed blob lookup for bundled custom assets. When
  // a manifest entry has `bundled: true`, AssetService resolves its bytes
  // from this store first (in-memory hot path).
  bundleStore?:     BundleStore;
  // Optional persistent cache. Consulted on bundled lookups when the store
  // misses; populated from successful wire pulls (unpinned).
  bundleCache?:     BundleCache;
  // Optional wire transport for bundled-asset pulls. Guest-side: the
  // transport pointing at the host. Host-side: omit (the host resolves
  // bundled bytes locally; their transports per peer are the serve side).
  bundleTransport?: BundleTransport;
  // PDF rendering seams — production wires the defaults from `./pdf/*`.
  // Tests inject fakes against the document-cache seam so no real pdfjs
  // ever runs in unit tests.
  pdfDocumentCache?: PdfDocumentCache;
  pdfRenderCache?:   PdfRenderCache;
  pdfPageRenderer?:  PdfPageRendererFn;
}

export type ProgressListener = (pending: number) => void;

export class AssetService {
  private images            = new Map<string, ImageEntry>();
  private models            = new Map<string, ModelEntry>();
  private sounds            = new Map<string, SoundEntry>();
  private sheets            = new Map<string, SheetEntry>();
  private imageLoader:        ImageLoader;
  private modelLoader:        ModelLoader;
  private soundLoader:        SoundLoader;
  private manifests:          Manifest[] = [];
  private bundleStore:        BundleStore     | undefined;
  private bundleCache:        BundleCache     | undefined;
  private bundleTransport:    BundleTransport | undefined;
  private pdfDocumentCache:   PdfDocumentCache;
  private pdfRenderCache:     PdfRenderCache;
  private pdfPageRenderer:    PdfPageRendererFn;
  private pending             = 0;
  private progressListeners   = new Set<ProgressListener>();

  constructor(opts: AssetServiceOptions = {}) {
    this.imageLoader      = opts.imageLoader ?? defaultImageLoader;
    this.modelLoader      = opts.modelLoader ?? defaultModelLoader;
    this.soundLoader      = opts.soundLoader ?? defaultSoundLoader;
    this.bundleStore      = opts.bundleStore;
    this.bundleCache      = opts.bundleCache;
    this.bundleTransport  = opts.bundleTransport;
    this.pdfDocumentCache = opts.pdfDocumentCache ?? new PdfDocumentCache();
    this.pdfRenderCache   = opts.pdfRenderCache   ?? new PdfRenderCache();
    this.pdfPageRenderer  = opts.pdfPageRenderer  ?? defaultPdfPageRenderer;
    if (opts.manifests) this.manifests = [...opts.manifests];
  }

  // Replace the slug-resolution catalog. Used at app boot to wire base +
  // primitive manifests, and again whenever the host's custom manifest
  // updates (slice #5 onwards). Cached slug entries are invalidated rather
  // than dropped so existing subscribers — components that called
  // `subscribe(slug, ...)` before the catalog changed — keep their
  // listeners and observe the pending → loaded/broken transition when the
  // resolved URL changes.
  setManifests(manifests: Manifest[]): void {
    this.manifests = [...manifests];
    for (const slug of [...this.sheets.keys()]) this.invalidateSheet(slug);
    for (const ref of [...this.images.keys()]) if (isSlug(ref)) this.invalidate(ref);
    for (const ref of [...this.models.keys()]) if (isSlug(ref)) this.invalidate(ref);
    for (const ref of [...this.sounds.keys()]) if (isSlug(ref)) this.invalidate(ref);
  }

  // Wire (or rewire) the content-addressed BundleStore the bundled-asset
  // resolution path consults. Room.tsx calls this once at boot after the
  // BundleStore has been rehydrated from the IDB BundleCache.
  setBundleStore(store: BundleStore | undefined): void {
    this.bundleStore = store;
  }

  setBundleCache(cache: BundleCache | undefined): void {
    this.bundleCache = cache;
  }

  // Guests call this with the BundleTransport pointing at the host once
  // the assets data channel is open. The miss-path of bundled lookups
  // then issues pulls over the wire; on success, the bytes are written
  // into BundleStore (in-memory) and BundleCache (unpinned) so subsequent
  // lookups short-circuit.
  setBundleTransport(transport: BundleTransport | undefined): void {
    this.bundleTransport = transport;
  }

  lookupSlug(slug: string): AssetEntry | undefined {
    for (const m of this.manifests) {
      const e = m.get(slug);
      if (e) return e;
    }
    return undefined;
  }

  // Flat list of every entry across every wired manifest (base + primitives +
  // host's published custom). Later manifests don't override earlier ones —
  // duplicate slugs (shouldn't happen in practice) keep the first hit.
  listAssets(opts: { type?: AssetType } = {}): AssetEntry[] {
    const seen = new Set<string>();
    const out: AssetEntry[] = [];
    for (const m of this.manifests) {
      for (const e of m.list(opts)) {
        if (seen.has(e.slug)) continue;
        seen.add(e.slug);
        out.push(e);
      }
    }
    return out;
  }

  // Promise-based accessor — resolves with the real asset on success or with
  // the type-default placeholder on failure. Never rejects, so callers don't
  // need a try/catch around resolve.
  resolve(ref: string, type: 'image'): Promise<THREE.Texture>;
  resolve(ref: string, type: 'model'): Promise<THREE.Object3D>;
  resolve(ref: string, type: 'sound'): Promise<AudioBuffer | null>;
  resolve(ref: string, type: AssetType): Promise<THREE.Texture | THREE.Object3D | AudioBuffer | null> {
    if (type === 'image') return this.ensureImage(ref).loadPromise;
    if (type === 'model') return this.ensureModel(ref).loadPromise;
    if (type === 'sound') return this.ensureSound(ref).loadPromise;
    return Promise.reject(new Error(`AssetService: unsupported type "${type}"`));
  }

  // Fires `listener` immediately with the current state, then again on every
  // transition (`pending` → `loaded`, `pending` → `broken`, post-invalidate).
  // Same ref subscribed twice triggers exactly one fetch.
  subscribe(ref: string, type: 'image', listener: ImageListener): () => void;
  subscribe(ref: string, type: 'model', listener: ModelListener): () => void;
  subscribe(ref: string, type: 'sound', listener: SoundListener): () => void;
  subscribe(ref: string, type: AssetType, listener: ImageListener | ModelListener | SoundListener): () => void {
    if (type === 'image') {
      const entry = this.ensureImage(ref);
      const fn    = listener as ImageListener;
      entry.listeners.add(fn);
      fn(entry.texture, entry.status);
      return () => {
        entry.listeners.delete(fn);
        if (entry.listeners.size === 0 && entry.cancelWirePull) {
          entry.cancelWirePull();
          // Drop the entry so a future subscribe re-fires the load with
          // a fresh state machine instead of latching on the cancelled
          // promise.
          this.images.delete(ref);
        }
      };
    }
    if (type === 'model') {
      const entry = this.ensureModel(ref);
      const fn    = listener as ModelListener;
      entry.listeners.add(fn);
      fn(entry.object3d, entry.status);
      return () => {
        entry.listeners.delete(fn);
        if (entry.listeners.size === 0 && entry.cancelWirePull) {
          entry.cancelWirePull();
          this.models.delete(ref);
        }
      };
    }
    if (type === 'sound') {
      const entry = this.ensureSound(ref);
      const fn    = listener as SoundListener;
      entry.listeners.add(fn);
      fn(entry.buffer, entry.status);
      return () => {
        entry.listeners.delete(fn);
        if (entry.listeners.size === 0 && entry.cancelWirePull) {
          entry.cancelWirePull();
          this.sounds.delete(ref);
        }
      };
    }
    throw new Error(`AssetService: unsupported type "${type}"`);
  }

  // Drops cached state for `ref` and re-fetches; existing listeners are
  // re-notified through the new entry. Used by manager UI on URL edit. If
  // `ref` is a 2-segment spritesheet slug, every sprite-ref subscriber under
  // that sheet is also refired.
  invalidate(ref: string): void {
    if (this.sheets.has(ref)) this.invalidateSheet(ref);
    const img = this.images.get(ref);
    if (img) {
      img.status  = 'pending';
      img.texture = getImagePlaceholder();
      for (const l of img.listeners) l(img.texture, 'pending');
      this.startImageLoad(ref, img);
    }
    const mdl = this.models.get(ref);
    if (mdl) {
      mdl.status   = 'pending';
      mdl.object3d = getModelPlaceholder();
      for (const l of mdl.listeners) l(mdl.object3d, 'pending');
      this.startModelLoad(ref, mdl);
    }
    const snd = this.sounds.get(ref);
    if (snd) {
      snd.status = 'pending';
      snd.buffer = null;
      for (const l of snd.listeners) l(null, 'pending');
      this.startSoundLoad(ref, snd);
    }
  }

  status(ref: string, type: AssetType): AssetStatus | null {
    if (type === 'image') return this.images.get(ref)?.status ?? null;
    if (type === 'model') return this.models.get(ref)?.status ?? null;
    if (type === 'sound') return this.sounds.get(ref)?.status ?? null;
    return null;
  }

  // Walks every entry across the supplied manifests with `preload: true` and
  // kicks off a resolve. Skips synthetic placeholder/primitive markers (no
  // network). Returns a promise that settles once every triggered fetch
  // finishes, success or fallback. While in flight, the pending counter
  // exposed via `subscribeProgress` reflects how many loads are outstanding.
  preload(manifests: Manifest | readonly Manifest[]): Promise<void> {
    const list = Array.isArray(manifests) ? manifests : [manifests as Manifest];
    const tasks: Promise<unknown>[] = [];
    for (const m of list) {
      for (const e of m.toArray()) {
        if (!e.preload) continue;
        if (e.url.startsWith('placeholder://')) continue;
        if (e.url.startsWith('primitive://'))   continue;
        if (e.type === 'spritesheet') {
          tasks.push(this.trackedSheetFetch(e.slug));
          continue;
        }
        tasks.push(this.trackedResolve(e.slug, e.type));
      }
    }
    if (tasks.length === 0) return Promise.resolve();
    return Promise.all(tasks).then(() => undefined);
  }

  pendingCount(): number {
    return this.pending;
  }

  // Subscribers receive the current pending count immediately and again on
  // every change. Used by the HUD indicator so it can render "Loading N…"
  // and dismiss when N drops back to zero.
  subscribeProgress(listener: ProgressListener): () => void {
    this.progressListeners.add(listener);
    listener(this.pending);
    return () => { this.progressListeners.delete(listener); };
  }

  private trackedResolve(ref: string, type: AssetType): Promise<unknown> {
    this.pending++;
    this.notifyProgress();
    const p: Promise<unknown> =
      type === 'image' ? this.resolve(ref, 'image') :
      type === 'model' ? this.resolve(ref, 'model') :
      type === 'sound' ? this.resolve(ref, 'sound') :
                         Promise.resolve();
    return p.finally(() => {
      this.pending--;
      this.notifyProgress();
    });
  }

  private trackedSheetFetch(slug: string): Promise<unknown> {
    this.pending++;
    this.notifyProgress();
    return this.ensureSheet(slug).loadPromise.finally(() => {
      this.pending--;
      this.notifyProgress();
    });
  }

  private notifyProgress(): void {
    for (const l of this.progressListeners) l(this.pending);
  }

  private ensureImage(ref: string): ImageEntry {
    const existing = this.images.get(ref);
    if (existing) return existing;
    const entry: ImageEntry = {
      status:      'pending',
      texture:     getImagePlaceholder(),
      listeners:   new Set(),
      loadPromise: Promise.resolve(getImagePlaceholder()),
    };
    this.images.set(ref, entry);
    this.startImageLoad(ref, entry);
    return entry;
  }

  private ensureModel(ref: string): ModelEntry {
    const existing = this.models.get(ref);
    if (existing) return existing;
    const entry: ModelEntry = {
      status:      'pending',
      object3d:    getModelPlaceholder(),
      listeners:   new Set(),
      loadPromise: Promise.resolve(getModelPlaceholder()),
    };
    this.models.set(ref, entry);
    this.startModelLoad(ref, entry);
    return entry;
  }

  private startImageLoad(ref: string, entry: ImageEntry): void {
    const pdfParsed = parsePdfRef(ref);
    if (pdfParsed) {
      this.startPdfPageLoad(entry, pdfParsed.slug, pdfParsed.page);
      return;
    }
    const parsed = parseRef(ref);
    if (parsed && parsed.kind === 'sprite') {
      this.startSpriteLoad(ref, entry, parsed.sheetSlug, parsed.index);
      return;
    }

    let url:        string;
    let slugBroken = false;

    if (isSlug(ref)) {
      const found = this.lookupSlug(ref);
      if (found && found.type === 'image') {
        if (found.bundled === true) {
          entry.loadPromise = this.loadBundledImage(entry, found.hash!);
          return;
        }
        url = found.url;
      } else {
        slugBroken = true;
        url = 'placeholder://image';
      }
    } else {
      url = ref;
    }

    if (url.startsWith('placeholder://') || url.startsWith('primitive://')) {
      entry.status      = slugBroken ? 'broken' : 'loaded';
      entry.texture     = placeholderTextureFor(url);
      entry.loadPromise = Promise.resolve(entry.texture);
      for (const l of entry.listeners) l(entry.texture, entry.status);
      return;
    }

    entry.loadPromise = this.imageLoader(url).then(
      (tex) => {
        entry.status  = 'loaded';
        entry.texture = tex;
        for (const l of entry.listeners) l(tex, 'loaded');
        return tex;
      },
      () => {
        entry.status = 'broken';
        for (const l of entry.listeners) l(entry.texture, 'broken');
        return entry.texture;
      },
    );
  }

  // Resolve a bundled image entry through the BundleStore → BundleCache →
  // BundleTransport chain. The first level that returns a Blob wins;
  // earlier levels are populated as we go so subsequent lookups
  // short-circuit. Decode hits the image loader against an Object URL
  // that is revoked exactly once after the loader settles.
  private loadBundledImage(entry: ImageEntry, hash: string): Promise<THREE.Texture> {
    const resolution = this.resolveBundleBlob(hash);
    entry.cancelWirePull = resolution.cancel;
    return resolution.promise.then((blob) => {
      entry.cancelWirePull = undefined;
      if (!blob) {
        entry.status = 'broken';
        for (const l of entry.listeners) l(entry.texture, 'broken');
        return entry.texture;
      }
      const objectUrl = URL.createObjectURL(blob);
      return this.imageLoader(objectUrl).then(
        (tex) => {
          entry.status  = 'loaded';
          entry.texture = tex;
          for (const l of entry.listeners) l(tex, 'loaded');
          return tex;
        },
        () => {
          entry.status = 'broken';
          for (const l of entry.listeners) l(entry.texture, 'broken');
          return entry.texture;
        },
      ).finally(() => {
        URL.revokeObjectURL(objectUrl);
      });
    });
  }

  // Bundle resolution chain: in-memory BundleStore → persistent
  // BundleCache → wire BundleTransport. Returns a Blob or null. The
  // returned `cancel` only stops the wire pull leg — cache lookups are
  // microtask-fast and complete regardless.
  private resolveBundleBlob(hash: string): { promise: Promise<Blob | null>; cancel: () => void } {
    let cancelled  = false;
    let wireCancel: (() => void) | null = null;

    const promise = (async () => {
      if (cancelled) return null;
      const local = this.bundleStore?.get(hash);
      if (local) return local;

      if (this.bundleCache) {
        const cached = await this.bundleCache.get(hash);
        if (cancelled) return null;
        if (cached) {
          this.bundleStore?.put(hash, cached);
          void this.bundleCache.touch(hash);
          return cached;
        }
      }

      if (this.bundleTransport) {
        const handle = this.bundleTransport.request(hash);
        wireCancel = handle.cancel;
        try {
          const blob = await handle.promise;
          if (cancelled) return null;
          this.bundleStore?.put(hash, blob);
          if (this.bundleCache) void this.bundleCache.put(hash, blob, { pinned: false });
          return blob;
        } catch {
          return null;
        } finally {
          wireCancel = null;
        }
      }

      return null;
    })();

    const cancel = () => {
      cancelled = true;
      wireCancel?.();
    };

    return { promise, cancel };
  }

  // Resolve a 3-segment sprite ref. Validates the parent sheet exists and the
  // index is in-bounds, ensures the parent sheet's underlying image is
  // fetched once (regardless of how many sprite refs subscribe), then clones
  // the parent texture with `offset`/`repeat` from spriteUV. Failure modes
  // (missing parent, wrong type, out-of-bounds, sheet load rejected) collapse
  // to the magenta placeholder + broken status.
  private startSpriteLoad(ref: string, entry: ImageEntry, sheetSlug: string, index: number): void {
    entry.sheetSlug = sheetSlug;

    const fail = () => {
      entry.status      = 'broken';
      entry.texture     = getImagePlaceholder();
      entry.loadPromise = Promise.resolve(entry.texture);
      for (const l of entry.listeners) l(entry.texture, 'broken');
    };

    const found = this.lookupSlug(sheetSlug);
    if (!found || found.type !== 'spritesheet') { fail(); return; }
    const cols = found.cols, rows = found.rows;
    if (!cols || !rows || index >= cols * rows) { fail(); return; }

    const sheet = this.ensureSheet(sheetSlug);
    entry.loadPromise = sheet.loadPromise.then((parentTex) => {
      if (!parentTex) {
        entry.status  = 'broken';
        entry.texture = getImagePlaceholder();
        for (const l of entry.listeners) l(entry.texture, 'broken');
        return entry.texture;
      }
      // Re-check bounds against the *current* manifest — cols/rows may have
      // shrunk between the sheet load kicking off and resolving.
      const currentSheet = this.lookupSlug(sheetSlug);
      if (!currentSheet || currentSheet.type !== 'spritesheet'
          || !currentSheet.cols || !currentSheet.rows
          || index >= currentSheet.cols * currentSheet.rows) {
        entry.status  = 'broken';
        entry.texture = getImagePlaceholder();
        for (const l of entry.listeners) l(entry.texture, 'broken');
        return entry.texture;
      }
      const clone = parentTex.clone();
      const uv    = spriteUV(index, currentSheet.cols, currentSheet.rows);
      clone.offset.set(uv.offsetX, uv.offsetY);
      clone.repeat.set(uv.repeatX, uv.repeatY);
      entry.status  = 'loaded';
      entry.texture = clone;
      for (const l of entry.listeners) l(clone, 'loaded');
      return clone;
    });
  }

  // Resolve a `pdf:<slug>/page/<n>` synthetic ref. Routes through
  // BundleStore/Cache/Transport for bytes (PDFs are upload-bundled),
  // PdfDocumentCache for parsing, and PdfRenderCache for rendered
  // textures. Failure modes (unknown / wrong-type slug, non-bundled
  // entry, out-of-range page, parse / render exception) collapse to the
  // magenta placeholder + broken status.
  private startPdfPageLoad(entry: ImageEntry, slug: string, page: number): void {
    const fail = (): THREE.Texture => {
      entry.status  = 'broken';
      entry.texture = getImagePlaceholder();
      for (const l of entry.listeners) l(entry.texture, 'broken');
      return entry.texture;
    };

    const cached = this.pdfRenderCache.get(slug, page, PDF_RENDER_SCALE);
    if (cached) {
      entry.status      = 'loaded';
      entry.texture     = cached;
      entry.loadPromise = Promise.resolve(cached);
      for (const l of entry.listeners) l(cached, 'loaded');
      return;
    }

    const found = this.lookupSlug(slug);
    if (!found || found.type !== 'pdf' || found.bundled !== true || !found.hash) {
      entry.loadPromise = Promise.resolve(fail());
      return;
    }

    const resolution = this.resolveBundleBlob(found.hash);
    entry.cancelWirePull = resolution.cancel;
    entry.loadPromise = resolution.promise.then(async (blob): Promise<THREE.Texture> => {
      entry.cancelWirePull = undefined;
      if (!blob) return fail();

      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await blob.arrayBuffer());
      } catch {
        return fail();
      }

      let doc: PDFDocumentProxy;
      try {
        doc = await this.pdfDocumentCache.getDocument(slug, bytes);
      } catch {
        return fail();
      }

      if (page < 1 || page > doc.numPages) return fail();

      let tex: THREE.CanvasTexture;
      try {
        tex = await this.pdfPageRenderer(doc, page, PDF_RENDER_SCALE);
      } catch {
        return fail();
      }

      this.pdfRenderCache.put(slug, page, PDF_RENDER_SCALE, tex);
      entry.status  = 'loaded';
      entry.texture = tex;
      for (const l of entry.listeners) l(tex, 'loaded');
      return tex;
    });
  }

  // Overlay path — resolves bytes through the bundle chain, hands the
  // PDF document to the caller. Used by the overlay sheet (Issue #9) and
  // by the text-layer integration (Issue #11). Each callsite owns the
  // returned doc only for the duration of its render; document caching
  // is handled inside `PdfDocumentCache`.
  async resolvePdfDocument(slug: string): Promise<PDFDocumentProxy | null> {
    const entry = this.lookupSlug(slug);
    if (!entry || entry.type !== 'pdf' || entry.bundled !== true || !entry.hash) return null;
    const blob = await this.resolveBundleBlob(entry.hash).promise;
    if (!blob) return null;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await blob.arrayBuffer());
    } catch {
      return null;
    }
    try {
      return await this.pdfDocumentCache.getDocument(slug, bytes);
    } catch {
      return null;
    }
  }

  // Subscribe to a spritesheet's parent-image load status. The Asset Manager
  // uses this to surface the warning badge on a broken sheet URL — sprite-ref
  // subscribers go broken automatically; the badge sees the underlying cause.
  subscribeSheet(slug: string, listener: SheetStatusListener): () => void {
    const entry = this.ensureSheet(slug);
    entry.listeners.add(listener);
    listener(entry.status);
    return () => { entry.listeners.delete(listener); };
  }

  private ensureSheet(slug: string): SheetEntry {
    const existing = this.sheets.get(slug);
    if (existing) return existing;
    const entry: SheetEntry = {
      status:      'pending',
      texture:     null,
      loadPromise: Promise.resolve(null),
      listeners:   new Set(),
    };
    this.sheets.set(slug, entry);
    this.startSheetLoad(slug, entry);
    return entry;
  }

  private startSheetLoad(slug: string, entry: SheetEntry): void {
    const notifySheet = (s: AssetStatus) => { for (const l of entry.listeners) l(s); };
    const found = this.lookupSlug(slug);
    if (!found || found.type !== 'spritesheet') {
      entry.status      = 'broken';
      entry.texture     = null;
      entry.loadPromise = Promise.resolve(null);
      notifySheet('broken');
      return;
    }
    entry.status = 'pending';
    notifySheet('pending');

    // Filters must be set BEFORE the texture is uploaded to the GPU.
    // The first upload happens when the clone is first rendered in a
    // material — by that point this Promise has resolved, the clone has
    // been created (inheriting `generateMipmaps`/`minFilter`), and the
    // source has its filter state locked in. See
    // planning/prd--sprite-sheet.md "Further Notes".
    const onLoaded = (tex: THREE.Texture): THREE.Texture => {
      tex.generateMipmaps = false;
      tex.minFilter       = THREE.LinearFilter;
      tex.magFilter       = THREE.LinearFilter;
      entry.status  = 'loaded';
      entry.texture = tex;
      notifySheet('loaded');
      return tex;
    };
    const onBroken = (): null => {
      entry.status  = 'broken';
      entry.texture = null;
      notifySheet('broken');
      return null;
    };

    if (found.bundled === true) {
      entry.loadPromise = this.resolveBundleBlob(found.hash!).promise.then((blob) => {
        if (!blob) return onBroken();
        const objectUrl = URL.createObjectURL(blob);
        return this.imageLoader(objectUrl)
          .then(onLoaded, onBroken)
          .finally(() => { URL.revokeObjectURL(objectUrl); });
      });
      return;
    }

    entry.loadPromise = this.imageLoader(found.url).then(onLoaded, onBroken);
  }

  // Drop the cached sheet texture and re-fetch through `startSheetLoad`.
  // Every sprite-ref entry depending on this sheet is also reset to pending
  // and re-evaluated against the (possibly new) manifest cols/rows.
  private invalidateSheet(slug: string): void {
    const sheet = this.sheets.get(slug);
    if (!sheet) return;
    this.startSheetLoad(slug, sheet);
    for (const [ref, entry] of this.images) {
      if (entry.sheetSlug !== slug) continue;
      entry.status  = 'pending';
      entry.texture = getImagePlaceholder();
      for (const l of entry.listeners) l(entry.texture, 'pending');
      const parsed = parseRef(ref);
      if (parsed && parsed.kind === 'sprite') {
        this.startSpriteLoad(ref, entry, parsed.sheetSlug, parsed.index);
      }
    }
  }

  private ensureSound(ref: string): SoundEntry {
    const existing = this.sounds.get(ref);
    if (existing) return existing;
    const entry: SoundEntry = {
      status:      'pending',
      buffer:      null,
      listeners:   new Set(),
      loadPromise: Promise.resolve(null),
    };
    this.sounds.set(ref, entry);
    this.startSoundLoad(ref, entry);
    return entry;
  }

  private startSoundLoad(ref: string, entry: SoundEntry): void {
    let url:        string;
    let slugBroken = false;

    if (isSlug(ref)) {
      const found = this.lookupSlug(ref);
      if (found && found.type === 'sound') {
        if (found.bundled === true) {
          entry.loadPromise = this.loadBundledSound(entry, found.hash!);
          return;
        }
        url = found.url;
      } else {
        slugBroken = true;
        url = 'placeholder://sound';
      }
    } else {
      url = ref;
    }

    if (url.startsWith('placeholder://') || url.startsWith('primitive://')) {
      entry.status      = slugBroken ? 'broken' : 'loaded';
      entry.buffer      = null;
      entry.loadPromise = Promise.resolve(null);
      for (const l of entry.listeners) l(null, entry.status);
      return;
    }

    entry.loadPromise = this.soundLoader(url).then(
      (buf) => {
        entry.status = 'loaded';
        entry.buffer = buf;
        for (const l of entry.listeners) l(buf, 'loaded');
        return buf as AudioBuffer | null;
      },
      () => {
        entry.status = 'broken';
        entry.buffer = null;
        for (const l of entry.listeners) l(null, 'broken');
        return null;
      },
    );
  }

  private loadBundledSound(entry: SoundEntry, hash: string): Promise<AudioBuffer | null> {
    const resolution = this.resolveBundleBlob(hash);
    entry.cancelWirePull = resolution.cancel;
    return resolution.promise.then((blob) => {
      entry.cancelWirePull = undefined;
      if (!blob) {
        entry.status = 'broken';
        entry.buffer = null;
        for (const l of entry.listeners) l(null, 'broken');
        return null;
      }
      const objectUrl = URL.createObjectURL(blob);
      return this.soundLoader(objectUrl).then(
        (buf) => {
          entry.status = 'loaded';
          entry.buffer = buf;
          for (const l of entry.listeners) l(buf, 'loaded');
          return buf as AudioBuffer | null;
        },
        () => {
          entry.status = 'broken';
          entry.buffer = null;
          for (const l of entry.listeners) l(null, 'broken');
          return null;
        },
      ).finally(() => {
        URL.revokeObjectURL(objectUrl);
      });
    });
  }

  private startModelLoad(ref: string, entry: ModelEntry): void {
    let url:        string;
    let slugBroken = false;

    if (isSlug(ref)) {
      const found = this.lookupSlug(ref);
      if (found && found.type === 'model') {
        if (found.bundled === true) {
          entry.loadPromise = this.loadBundledModel(entry, found.hash!);
          return;
        }
        url = found.url;
      } else {
        slugBroken = true;
        url = 'placeholder://model';
      }
    } else {
      url = ref;
    }

    if (url.startsWith('placeholder://') || url.startsWith('primitive://')) {
      // Primitives short-circuit — MeshComponent renders them via buildMesh
      // and never actually subscribes for these refs, but we still surface
      // a deterministic 'loaded' status so the picker thumbnail logic works.
      entry.status      = slugBroken ? 'broken' : 'loaded';
      entry.object3d    = getModelPlaceholder();
      entry.loadPromise = Promise.resolve(entry.object3d);
      for (const l of entry.listeners) l(entry.object3d, entry.status);
      return;
    }

    entry.loadPromise = this.modelLoader(url).then(
      (obj) => {
        entry.status   = 'loaded';
        entry.object3d = obj;
        for (const l of entry.listeners) l(obj, 'loaded');
        return obj;
      },
      () => {
        entry.status = 'broken';
        for (const l of entry.listeners) l(entry.object3d, 'broken');
        return entry.object3d;
      },
    );
  }

  private loadBundledModel(entry: ModelEntry, hash: string): Promise<THREE.Object3D> {
    const resolution = this.resolveBundleBlob(hash);
    entry.cancelWirePull = resolution.cancel;
    return resolution.promise.then((blob) => {
      entry.cancelWirePull = undefined;
      if (!blob) {
        entry.status = 'broken';
        for (const l of entry.listeners) l(entry.object3d, 'broken');
        return entry.object3d;
      }
      const objectUrl = URL.createObjectURL(blob);
      return this.modelLoader(objectUrl).then(
        (obj) => {
          entry.status   = 'loaded';
          entry.object3d = obj;
          for (const l of entry.listeners) l(obj, 'loaded');
          return obj;
        },
        () => {
          entry.status = 'broken';
          for (const l of entry.listeners) l(entry.object3d, 'broken');
          return entry.object3d;
        },
      ).finally(() => {
        URL.revokeObjectURL(objectUrl);
      });
    });
  }
}

export const assetService = new AssetService({ manifests: [BASE_MANIFEST, PRIMITIVE_MANIFEST] });

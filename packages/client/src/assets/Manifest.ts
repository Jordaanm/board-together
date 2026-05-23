// Pure, immutable asset manifest. Issue #2 of issues--asset-registry.md.
//
// `Manifest` is a value object — every mutation (`add`, `update`, `delete`)
// returns a new instance. Slug is the primary key and is immutable on update;
// `name`, `url`, `preload`, `description`, `tags` are mutable.
//
// Slug format: `<namespace>:<body>`, where namespace is one of `base`,
// `custom`, `prim` and body is `[a-z0-9][a-z0-9_/-]*`. The slug character set
// is intentionally narrow so save files and wire payloads stay terse and
// case-folding can't introduce ambiguity.

export type AssetType = 'image' | 'model' | 'sound' | 'spritesheet' | 'pdf';

export interface AssetEntry {
  slug:         string;
  name:         string;
  type:         AssetType;
  url:          string;
  preload:      boolean;
  description?: string;
  tags?:        string[];
  // spritesheet-only: positive integers. Required iff type === 'spritesheet',
  // rejected otherwise. cols/rows are mutable on update — hosts iterate on
  // the grid without a re-import flow.
  cols?:        number;
  rows?:        number;
  // Bundled-asset fields (custom: namespace only). When `bundled === true`,
  // bytes are content-addressed in the BundleStore by `hash` (lowercase
  // SHA-256 hex); `url` is preserved as an optional breadcrumb only.
  // `size` is the bundled blob's byte count, replicated in the manifest so
  // peers can show totals before fetching bytes and so save / replication
  // round-trips don't have to re-hash.
  bundled?:     boolean;
  hash?:        string;
  size?:        number;
  // pdf-only: positive finite number — page-1 width / height. Captured at
  // upload so spawned PDF entities can size their depth without parsing
  // the PDF on every spawn.
  aspectRatio?: number;
  // pdf-only: total page count. Captured at upload so the entity can
  // clamp `setPage(n)` and surface a `currentPage / pageCount` indicator
  // without parsing the PDF.
  pageCount?: number;
}

export class ManifestError extends Error {}

export const ALLOWED_NAMESPACES = ['base', 'custom', 'prim'] as const;
export type Namespace = (typeof ALLOWED_NAMESPACES)[number];

const NAMESPACE_SET = new Set<string>(ALLOWED_NAMESPACES);
const SLUG_RE       = /^[a-z][a-z0-9]*:[a-z0-9][a-z0-9_/-]*$/;

export type ValidateSlugResult = { ok: true } | { ok: false; error: string };

export function validateSlug(slug: unknown, expectedNamespace?: Namespace): ValidateSlugResult {
  if (typeof slug !== 'string')          return { ok: false, error: 'slug must be a string' };
  if (slug.length === 0)                 return { ok: false, error: 'slug must not be empty' };
  if (!SLUG_RE.test(slug))               return { ok: false, error: `invalid slug format: "${slug}"` };
  const ns = slug.slice(0, slug.indexOf(':'));
  if (!NAMESPACE_SET.has(ns))            return { ok: false, error: `unknown namespace: "${ns}"` };
  if (expectedNamespace && ns !== expectedNamespace) {
    return { ok: false, error: `expected namespace "${expectedNamespace}", got "${ns}"` };
  }
  return { ok: true };
}

export function namespaceOf(slug: string): Namespace | null {
  const idx = slug.indexOf(':');
  if (idx === -1) return null;
  const ns = slug.slice(0, idx);
  return NAMESPACE_SET.has(ns) ? (ns as Namespace) : null;
}

// Quick check used by AssetService to decide whether a ref is a slug or a URL.
// Returns true only when the prefix is a known namespace — avoids matching
// `http:` or `data:` etc.
export function isSlug(ref: string): boolean {
  return namespaceOf(ref) !== null;
}

const ASSET_TYPES = new Set<AssetType>(['image', 'model', 'sound', 'spritesheet', 'pdf']);
const HASH_RE     = /^[a-f0-9]{64}$/;

function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1;
}

function validateEntry(entry: AssetEntry): void {
  const slugCheck = validateSlug(entry.slug);
  if (!slugCheck.ok) throw new ManifestError(slugCheck.error);
  if (typeof entry.name !== 'string' || entry.name.length === 0) {
    throw new ManifestError(`entry "${entry.slug}": name must be a non-empty string`);
  }
  if (!ASSET_TYPES.has(entry.type)) {
    throw new ManifestError(`entry "${entry.slug}": unknown type "${entry.type}"`);
  }
  if (typeof entry.url !== 'string') {
    throw new ManifestError(`entry "${entry.slug}": url must be a string`);
  }
  if (typeof entry.preload !== 'boolean') {
    throw new ManifestError(`entry "${entry.slug}": preload must be a boolean`);
  }
  if (entry.description !== undefined && typeof entry.description !== 'string') {
    throw new ManifestError(`entry "${entry.slug}": description must be a string`);
  }
  if (entry.tags !== undefined && (!Array.isArray(entry.tags) || entry.tags.some(t => typeof t !== 'string'))) {
    throw new ManifestError(`entry "${entry.slug}": tags must be a string array`);
  }
  if (entry.type === 'spritesheet') {
    if (namespaceOf(entry.slug) !== 'custom') {
      throw new ManifestError(`entry "${entry.slug}": spritesheet entries must use the "custom" namespace`);
    }
    if (!isPositiveInt(entry.cols)) {
      throw new ManifestError(`entry "${entry.slug}": spritesheet cols must be a positive integer`);
    }
    if (!isPositiveInt(entry.rows)) {
      throw new ManifestError(`entry "${entry.slug}": spritesheet rows must be a positive integer`);
    }
  } else {
    if (entry.cols !== undefined) {
      throw new ManifestError(`entry "${entry.slug}": cols is only valid on spritesheet entries`);
    }
    if (entry.rows !== undefined) {
      throw new ManifestError(`entry "${entry.slug}": rows is only valid on spritesheet entries`);
    }
  }
  if (entry.type === 'pdf') {
    if (namespaceOf(entry.slug) !== 'custom') {
      throw new ManifestError(`entry "${entry.slug}": pdf entries must use the "custom" namespace`);
    }
    if (entry.aspectRatio !== undefined) {
      if (typeof entry.aspectRatio !== 'number' || !Number.isFinite(entry.aspectRatio) || entry.aspectRatio <= 0) {
        throw new ManifestError(`entry "${entry.slug}": aspectRatio must be a positive finite number`);
      }
    }
    if (entry.pageCount !== undefined && !isPositiveInt(entry.pageCount)) {
      throw new ManifestError(`entry "${entry.slug}": pageCount must be a positive integer`);
    }
  } else {
    if (entry.aspectRatio !== undefined) {
      throw new ManifestError(`entry "${entry.slug}": aspectRatio is only valid on pdf entries`);
    }
    if (entry.pageCount !== undefined) {
      throw new ManifestError(`entry "${entry.slug}": pageCount is only valid on pdf entries`);
    }
  }
  if (entry.bundled !== undefined && typeof entry.bundled !== 'boolean') {
    throw new ManifestError(`entry "${entry.slug}": bundled must be a boolean`);
  }
  if (entry.hash !== undefined && typeof entry.hash !== 'string') {
    throw new ManifestError(`entry "${entry.slug}": hash must be a string`);
  }
  if (entry.size !== undefined && (typeof entry.size !== 'number' || !Number.isFinite(entry.size) || entry.size < 0 || !Number.isInteger(entry.size))) {
    throw new ManifestError(`entry "${entry.slug}": size must be a non-negative integer`);
  }
  if (entry.bundled === true) {
    if (namespaceOf(entry.slug) !== 'custom') {
      throw new ManifestError(`entry "${entry.slug}": bundled entries must use the "custom" namespace`);
    }
    if (typeof entry.hash !== 'string') {
      throw new ManifestError(`entry "${entry.slug}": bundled entries require a hash`);
    }
    if (!HASH_RE.test(entry.hash)) {
      throw new ManifestError(`entry "${entry.slug}": hash must be 64 lowercase hex chars`);
    }
    if (typeof entry.size !== 'number') {
      throw new ManifestError(`entry "${entry.slug}": bundled entries require a size`);
    }
  } else {
    if (entry.hash !== undefined) {
      throw new ManifestError(`entry "${entry.slug}": hash is only valid on bundled entries`);
    }
    if (entry.size !== undefined) {
      throw new ManifestError(`entry "${entry.slug}": size is only valid on bundled entries`);
    }
  }
}

export class Manifest {
  private constructor(private readonly entries: ReadonlyMap<string, AssetEntry>) {}

  static empty(): Manifest {
    return new Manifest(new Map());
  }

  static from(entries: readonly AssetEntry[]): Manifest {
    const map = new Map<string, AssetEntry>();
    for (const e of entries) {
      validateEntry(e);
      if (map.has(e.slug)) {
        throw new ManifestError(`duplicate slug: "${e.slug}"`);
      }
      map.set(e.slug, { ...e, tags: e.tags ? [...e.tags] : undefined });
    }
    return new Manifest(map);
  }

  add(entry: AssetEntry): Manifest {
    validateEntry(entry);
    if (this.entries.has(entry.slug)) {
      throw new ManifestError(`slug already exists: "${entry.slug}"`);
    }
    const next = new Map(this.entries);
    next.set(entry.slug, { ...entry, tags: entry.tags ? [...entry.tags] : undefined });
    return new Manifest(next);
  }

  update(slug: string, partial: Partial<Omit<AssetEntry, 'slug' | 'type'>> & { slug?: string; type?: AssetType }): Manifest {
    const existing = this.entries.get(slug);
    if (!existing) throw new ManifestError(`unknown slug: "${slug}"`);
    if (partial.slug !== undefined && partial.slug !== slug) {
      throw new ManifestError(`slug is immutable: cannot rename "${slug}" → "${partial.slug}"`);
    }
    if (partial.type !== undefined && partial.type !== existing.type) {
      throw new ManifestError(`type is immutable: cannot change "${slug}" type "${existing.type}" → "${partial.type}"`);
    }
    const merged: AssetEntry = {
      ...existing,
      ...partial,
      slug: existing.slug,
      type: existing.type,
      tags: partial.tags !== undefined
        ? [...partial.tags]
        : existing.tags ? [...existing.tags] : undefined,
    };
    validateEntry(merged);
    const next = new Map(this.entries);
    next.set(slug, merged);
    return new Manifest(next);
  }

  delete(slug: string): Manifest {
    if (!this.entries.has(slug)) return this;
    const next = new Map(this.entries);
    next.delete(slug);
    return new Manifest(next);
  }

  get(slug: string): AssetEntry | undefined {
    const e = this.entries.get(slug);
    return e ? { ...e, tags: e.tags ? [...e.tags] : undefined } : undefined;
  }

  hasSlug(slug: string): boolean {
    return this.entries.has(slug);
  }

  list(opts: { type?: AssetType } = {}): AssetEntry[] {
    const out: AssetEntry[] = [];
    for (const e of this.entries.values()) {
      if (opts.type && e.type !== opts.type) continue;
      out.push({ ...e, tags: e.tags ? [...e.tags] : undefined });
    }
    return out;
  }

  size(): number {
    return this.entries.size;
  }

  toArray(): AssetEntry[] {
    return this.list();
  }
}

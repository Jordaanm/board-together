// In-memory content-addressed blob store. Keys are SHA-256 hex strings
// produced by BundleHasher; values are Blobs. Lives at the AssetService /
// host-page layer — pure data, no DOM, no fetch, no WebRTC.
//
// The optional `onPut` / `onDelete` hooks let a later slice (#5) wire IDB
// persistence in without this module knowing about it.

export interface BundleStoreOptions {
  onPut?:    (hash: string, blob: Blob) => void;
  onDelete?: (hash: string) => void;
}

export type BundleStoreListener = (event:
  | { kind: 'put';    hash: string; blob: Blob }
  | { kind: 'delete'; hash: string }
) => void;

export class BundleStore {
  private readonly entries = new Map<string, Blob>();
  private readonly onPut?:    (hash: string, blob: Blob) => void;
  private readonly onDelete?: (hash: string) => void;
  private readonly listeners = new Set<BundleStoreListener>();

  constructor(opts: BundleStoreOptions = {}) {
    this.onPut    = opts.onPut;
    this.onDelete = opts.onDelete;
  }

  get(hash: string): Blob | undefined {
    return this.entries.get(hash);
  }

  has(hash: string): boolean {
    return this.entries.has(hash);
  }

  put(hash: string, blob: Blob): void {
    if (this.entries.has(hash)) return;
    this.entries.set(hash, blob);
    this.onPut?.(hash, blob);
    for (const l of this.listeners) l({ kind: 'put', hash, blob });
  }

  delete(hash: string): boolean {
    const had = this.entries.delete(hash);
    if (had) {
      this.onDelete?.(hash);
      for (const l of this.listeners) l({ kind: 'delete', hash });
    }
    return had;
  }

  // Total bytes across all stored blobs.
  size(): number {
    let total = 0;
    for (const blob of this.entries.values()) total += blob.size;
    return total;
  }

  list(): string[] {
    return [...this.entries.keys()];
  }

  // Iterate over `[hash, blob]` pairs. Used by ConnectionManager to wire
  // the host's current content into a freshly-opened BundleTransport.
  pairs(): IterableIterator<[string, Blob]> {
    return this.entries.entries();
  }

  // Observe puts / deletes. The host's wire layer uses this to push new
  // uploads onto every connected peer's BundleTransport without having to
  // poll the store.
  subscribe(listener: BundleStoreListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

// Host-side state machine for the custom asset manifest. Issue #3 of
// issues--asset-registry.md.
//
// The store owns two `Manifest` values: a `draft` (the host's working copy
// edited via the manager modal) and `published` (the snapshot last broadcast
// to peers). Edits go to the draft; `push()` promotes the draft to published
// and returns the snapshot to broadcast on the wire.
//
// `loadFromSave(saved)` sets both draft and published — reloading a save acts
// as an implicit push, so reconnecting peers see exactly the host's last
// authored state. Wire-side replication lands in slice #5; this slice ships
// the store + persistence so manager UI work in slice #4 has somewhere to
// write to.

import { Manifest, type AssetEntry } from './Manifest';

export class ManifestStore {
  private draft:     Manifest;
  private published: Manifest;
  private listeners = new Set<() => void>();

  constructor(initial: Manifest = Manifest.empty()) {
    this.draft     = initial;
    this.published = initial;
  }

  getDraft():     Manifest { return this.draft; }
  getPublished(): Manifest { return this.published; }

  editDraft(op: (draft: Manifest) => Manifest): void {
    const next = op(this.draft);
    if (next === this.draft) return;
    this.draft = next;
    this.notify();
  }

  unpushedCount(): number {
    let count = 0;
    const draftSlugs = new Set<string>();
    for (const e of this.draft.toArray()) {
      draftSlugs.add(e.slug);
      const pub = this.published.get(e.slug);
      if (!pub || !entriesEqual(pub, e)) count++;
    }
    for (const e of this.published.toArray()) {
      if (!draftSlugs.has(e.slug)) count++;
    }
    return count;
  }

  // Promote draft → published and return the snapshot to broadcast. Caller
  // is responsible for shipping it on the wire.
  push(): AssetEntry[] {
    this.published = this.draft;
    const snapshot = this.draft.toArray();
    this.notify();
    return snapshot;
  }

  // Used by guests after receiving a manifest-publish wire message. Sets both
  // draft and published so the guest's local manager view matches what the
  // host has shared.
  applyPublishedSnapshot(snapshot: readonly AssetEntry[]): void {
    const next = Manifest.from(snapshot);
    this.draft     = next;
    this.published = next;
    this.notify();
  }

  // Reload-from-save: implicit-push semantics. Both draft and published are
  // set to the saved manifest so that the next session-start re-publish
  // delivers the saved state intact.
  loadFromSave(saved: readonly AssetEntry[]): void {
    const next = Manifest.from(saved);
    this.draft     = next;
    this.published = next;
    this.notify();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

function entriesEqual(a: AssetEntry, b: AssetEntry): boolean {
  return a.slug                     === b.slug
      && a.name                     === b.name
      && a.type                     === b.type
      && a.url                      === b.url
      && a.preload                  === b.preload
      && (a.description ?? '')      === (b.description ?? '')
      && tagsEqual(a.tags, b.tags)
      && (a.bundled ?? false)       === (b.bundled ?? false)
      && (a.hash    ?? '')          === (b.hash    ?? '');
}

function tagsEqual(a?: string[], b?: string[]): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
  return true;
}

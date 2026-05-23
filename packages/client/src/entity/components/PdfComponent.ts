// PDF entity behaviour. Composes with sibling MeshComponent (prim:page)
// to render the current page on the +Y face via the synthetic
// `pdf:<slug>/page/<n>` ref.
//
// State (replicated):
//   - `assetSlug` — manifest slug of the bundled PDF (empty when unset).
//   - `currentPage` — 1-based page index. Bounds clamped against the
//     manifest entry's `pageCount` so out-of-range setPage calls land on
//     a valid page rather than silently breaking the texture.
//
// Mutators (setPage / nextPage / previousPage) are seat-gated — a
// spectator's call is a no-op so a non-seated viewer can't drive page
// flips from the floating buttons (Issue #8). Scripts (Issue #15) reach
// the same mutators through the host's seat.
//
// Emits `pdf:page-changed { from, to }` on every successful flip so
// React overlays + user scripts can react without polling state.

import {
  EntityComponent,
  type SpawnContext,
  type ActionContext,
} from '../EntityComponent';
import { type PropertyDef } from '../propertySchema';
import { type SeatIndex } from '../../seats/SeatLayout';
import { MeshComponent } from './MeshComponent';
import { assetService } from '../../assets/AssetService';
import { formatPdfRef } from '../../assets/pdfRef';

export interface PdfState {
  assetSlug:   string;
  currentPage: number;
}

export interface PdfMutatorContext {
  recipientSeat: SeatIndex | null;
}

export interface PdfPageChanged {
  from: number;
  to:   number;
}

export class PdfComponent extends EntityComponent<PdfState> {
  static typeId   = 'pdf';
  static label    = 'PDF';
  static requires = ['transform', 'mesh'] as const;
  static propertySchema: readonly PropertyDef<PdfState>[] = [
    { key: 'assetSlug', label: 'PDF', type: 'asset:pdf' },
  ];

  onSpawn(_ctx: SpawnContext): void {
    this.applyTextureRef();
    this.applyAspectSizing();
  }

  onPropertiesChanged(changed: Partial<PdfState>): void {
    if (changed.assetSlug !== undefined) {
      // Slug change → re-derive depth from the new manifest aspect and
      // reset to page 1 so the entity isn't stuck on a stale page index
      // that's past the new document's end.
      this.applyAspectSizing();
      if (changed.currentPage === undefined && this.state.currentPage !== 1) {
        this.setState({ currentPage: 1 });
        return; // recursive setState already rewires textureRefs.
      }
    }
    if (changed.assetSlug !== undefined || changed.currentPage !== undefined) {
      this.applyTextureRef();
    }
  }

  // ── Public read API ────────────────────────────────────────────────────
  pageCount(): number {
    if (!this.state.assetSlug) return 0;
    const entry = assetService.lookupSlug(this.state.assetSlug);
    if (!entry || entry.type !== 'pdf') return 0;
    return entry.pageCount ?? 0;
  }

  aspectRatio(): number | undefined {
    if (!this.state.assetSlug) return undefined;
    const entry = assetService.lookupSlug(this.state.assetSlug);
    if (!entry || entry.type !== 'pdf') return undefined;
    return entry.aspectRatio;
  }

  // ── Public mutators (seat-gated) ───────────────────────────────────────
  setPage(n: number, ctx: PdfMutatorContext): void {
    if (ctx.recipientSeat === null) return;
    if (!this.state.assetSlug) return;
    const count   = this.pageCount();
    const upper   = count > 0 ? count : n; // unknown count → trust input upper
    const clamped = Math.max(1, Math.min(upper, Math.trunc(n)));
    if (!Number.isFinite(clamped) || clamped < 1) return;
    if (clamped === this.state.currentPage) return;
    const from = this.state.currentPage;
    this.setState({ currentPage: clamped });
    this.entity.dispatchEvent<PdfPageChanged>('pdf:page-changed', { from, to: clamped });
  }

  nextPage(ctx: PdfMutatorContext): void {
    this.setPage(this.state.currentPage + 1, ctx);
  }

  previousPage(ctx: PdfMutatorContext): void {
    this.setPage(this.state.currentPage - 1, ctx);
  }

  // Pure-action surface. Lets the floating buttons (Issue #8) and the
  // hotkey dispatcher route through the standard `dispatchAction` path
  // — guests fire `invoke-action`, the host gates on seat + applies via
  // `setPage`. `recipientSeat` from ActionContext flows straight into
  // the seat-gated mutator.
  onAction(name: string, ctx: ActionContext): void {
    const mut: PdfMutatorContext = { recipientSeat: ctx.recipientSeat };
    if (name === 'pdf-next') { this.nextPage(mut);     return; }
    if (name === 'pdf-prev') { this.previousPage(mut); return; }
  }

  // ── Internals ──────────────────────────────────────────────────────────
  private applyTextureRef(): void {
    const mesh = this.entity.getComponent(MeshComponent);
    if (!mesh) return;
    const slug = this.state.assetSlug;
    const page = this.state.currentPage;
    const face = slug ? formatPdfRef(slug, page) : '';
    if (mesh.state.textureRefs?.face === face) return;
    mesh.setState({ textureRefs: { ...mesh.state.textureRefs, face } });
  }

  // Size the mesh's depth so width / depth matches the PDF's aspect.
  // PDF aspect = page width / page height; entity width is the world
  // horizontal, depth is the world vertical (prim:page lies flat on
  // its +Y face). depth = width / aspect keeps both pages and entity
  // visually proportional.
  private applyAspectSizing(): void {
    const mesh = this.entity.getComponent(MeshComponent);
    if (!mesh) return;
    const aspect = this.aspectRatio();
    if (aspect === undefined || aspect <= 0) return;
    const depth = mesh.state.width / aspect;
    if (Math.abs(mesh.state.depth - depth) < 1e-6) return;
    mesh.setState({ depth });
  }
}

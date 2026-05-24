// Script-facing facade over a PdfComponent. Returned from
// `EntityFacade.pdf` for any entity carrying a PdfComponent. Host-only
// writes — guests see no-ops via missing `ctx.pdfOps`. Issue #15 of
// issues--pdf.md.

import { type Entity } from '../entity/Entity';
import { PdfComponent } from '../entity/components/PdfComponent';
import { type ScriptRunContext } from './EntityFacade';

// Host wiring: the three mutators the PDF facade calls into. World
// implements these against `PdfComponent.setPage` with the host's
// own seat in the mutator context, so guests cannot side-step the
// seat gate.
export interface PdfOps {
  setPage:      (entityId: string, page: number) => void;
  nextPage:     (entityId: string) => void;
  previousPage: (entityId: string) => void;
}

export class PdfFacade {
  constructor(
    private readonly entity_: Entity,
    private readonly ctx:     ScriptRunContext,
  ) {}

  // ── Read API ───────────────────────────────────────────────────────────
  get currentPage(): number {
    const pdf = this.entity_.getComponent(PdfComponent);
    return pdf ? pdf.state.currentPage : 0;
  }

  get pageCount(): number {
    const pdf = this.entity_.getComponent(PdfComponent);
    return pdf ? pdf.pageCount() : 0;
  }

  get assetSlug(): string {
    const pdf = this.entity_.getComponent(PdfComponent);
    return pdf ? pdf.state.assetSlug : '';
  }

  // ── Write API (host-only) ──────────────────────────────────────────────
  setPage(n: number): void {
    const ops = this.ctx.pdfOps;
    if (!ops) {
      this.ctx.warn?.('pdf.setPage: no-op (host-only API; not running on host)');
      return;
    }
    ops.setPage(this.entity_.id, n);
  }

  nextPage(): void {
    const ops = this.ctx.pdfOps;
    if (!ops) {
      this.ctx.warn?.('pdf.nextPage: no-op (host-only API; not running on host)');
      return;
    }
    ops.nextPage(this.entity_.id);
  }

  previousPage(): void {
    const ops = this.ctx.pdfOps;
    if (!ops) {
      this.ctx.warn?.('pdf.previousPage: no-op (host-only API; not running on host)');
      return;
    }
    ops.previousPage(this.entity_.id);
  }
}

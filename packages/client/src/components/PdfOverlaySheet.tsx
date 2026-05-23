// Per-viewer slide-out sheet that shows the open-in-overlay PDF page
// at higher DPI than the in-world face. Mounted at the
// `middle-right` AnchorLayout anchor; non-modal so the 3D canvas
// stays interactive while it's open. Esc and the X button close.
//
// Issue #9 wires only the image render. Issue #11 layers the pdfjs
// text layer on top of the canvas for selectable/copyable text.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useAnchorTarget } from './AnchorLayout';
import { createPortal } from 'react-dom';
import { assetService } from '../assets/AssetService';
import { renderPageCanvas } from '../assets/pdf/PdfPageRenderer';
import {
  type PdfOverlayController,
  type PdfOverlayState,
} from './PdfOverlayController';

// Render scale for the overlay. Higher than the in-world value
// (1.5) so glyphs are crisp at desktop pixel densities.
const OVERLAY_SCALE = 2.0;

interface Props {
  controller: PdfOverlayController;
}

const SHEET: React.CSSProperties = {
  position:      'absolute',
  right:         16,
  width:         480,
  maxHeight:     'calc(100vh - 32px)',
  background:    'var(--surface)',
  border:        '1px solid var(--line)',
  borderRadius:  'var(--panel-radius)',
  color:         'var(--ink)',
  boxShadow:     'var(--shadow-lg)',
  display:       'flex',
  flexDirection: 'column',
  fontFamily:    'var(--font-sans)',
  fontSize:      13,
  zIndex:        150,
  pointerEvents: 'auto',
};

const HEADER: React.CSSProperties = {
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'space-between',
  padding:        '10px 14px',
  borderBottom:   '1px solid var(--line)',
  flexShrink:     0,
  gap:            6,
};

const TITLE: React.CSSProperties = {
  fontFamily:    'var(--font-serif)',
  fontWeight:    600,
  fontSize:      14,
  letterSpacing: '-0.01em',
  margin:        0,
  whiteSpace:    'nowrap',
  textOverflow:  'ellipsis',
  overflow:      'hidden',
  flex:          1,
};

const NAV_ROW: React.CSSProperties = {
  display:    'flex',
  alignItems: 'center',
  gap:        4,
  fontSize:   12,
  color:      'var(--ink-2)',
};

const NAV_BTN: React.CSSProperties = {
  background:   'var(--surface-2)',
  border:       '1px solid var(--line-strong)',
  color:        'var(--ink)',
  borderRadius: 3,
  cursor:       'pointer',
  fontSize:     14,
  lineHeight:   1,
  padding:      '2px 8px',
  fontFamily:   'inherit',
};

const NAV_BTN_DISABLED: React.CSSProperties = {
  ...NAV_BTN,
  opacity: 0.4,
  cursor:  'not-allowed',
};

const PAGE_INPUT: React.CSSProperties = {
  background:   'var(--bg)',
  border:       '1px solid var(--line-strong)',
  color:        'var(--ink)',
  borderRadius: 3,
  fontSize:     12,
  fontFamily:   'inherit',
  padding:      '2px 4px',
  width:        44,
  textAlign:    'center',
};

const CLOSE_BTN: React.CSSProperties = {
  background:   'none',
  border:       'none',
  color:        'var(--ink-mute)',
  cursor:       'pointer',
  fontSize:     18,
  lineHeight:   1,
  padding:      '0 4px',
};

const BODY: React.CSSProperties = {
  padding:    '12px 14px',
  overflow:   'auto',
  background: 'var(--bg)',
};

const CANVAS_WRAPPER: React.CSSProperties = {
  position:   'relative',
  width:      '100%',
};

const STATUS: React.CSSProperties = {
  padding:   '40px 14px',
  textAlign: 'center',
  color:     'var(--ink-mute)',
  fontSize:  12,
};

export function PdfOverlaySheet({ controller }: Props) {
  const state = useSyncExternalStore<PdfOverlayState>(
    (cb) => controller.subscribe(cb),
    () => controller.getState(),
    () => null,
  );

  const anchor = useAnchorTarget('middle-right');
  if (state === null || !anchor) return null;
  return createPortal(<SheetBody controller={controller} state={state} />, anchor);
}

function SheetBody({
  controller, state,
}: {
  controller: PdfOverlayController;
  state:      { assetSlug: string; page: number };
}) {
  const wrapperRef   = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'broken'>('loading');
  // Local draft for the page-input — lets the user type partial values
  // ("12") without the controller seeing every keystroke.
  const [pageInputDraft, setPageInputDraft] = useState<string>(String(state.page));

  // pageCount is pulled from the manifest entry. Read once per slug —
  // the value is upload-time-fixed for that PDF.
  const pageCount = useMemo(() => {
    const entry = assetService.lookupSlug(state.assetSlug);
    if (!entry || entry.type !== 'pdf') return 0;
    return entry.pageCount ?? 0;
  }, [state.assetSlug]);

  // Sync the input draft with controller state when the page changes
  // through arrows / keyboard / external setPage (e.g. another open()).
  useEffect(() => {
    setPageInputDraft(String(state.page));
  }, [state.page]);

  // Focus the sheet on open so the in-sheet keyboard shortcuts are
  // active without an extra click. The 3D canvas's own listeners
  // continue to receive key events when focus is elsewhere.
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  // Escape closes the sheet. Captured at window level so it fires no
  // matter where the focus is (3D canvas, the sheet itself, etc.) —
  // the only modals that should swallow Escape (radix Dialog) already
  // call stopPropagation on their own listeners.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        controller.close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller]);

  // (Re)render the page whenever assetSlug or page changes. Each
  // render replaces the wrapper's children — the previous canvas is
  // discarded as the new one is appended.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    let cancelled = false;
    setStatus('loading');
    (async () => {
      const doc = await assetService.resolvePdfDocument(state.assetSlug);
      if (cancelled || !wrapper.isConnected) return;
      if (!doc) { setStatus('broken'); return; }
      if (state.page < 1 || state.page > doc.numPages) { setStatus('broken'); return; }
      let canvas: HTMLCanvasElement;
      try {
        canvas = await renderPageCanvas(doc, state.page, OVERLAY_SCALE);
      } catch {
        if (cancelled) return;
        setStatus('broken');
        return;
      }
      if (cancelled || !wrapper.isConnected) return;
      canvas.style.width    = '100%';
      canvas.style.height   = 'auto';
      canvas.style.display  = 'block';
      while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
      wrapper.appendChild(canvas);
      setStatus('ready');
    })();
    return () => { cancelled = true; };
  }, [state.assetSlug, state.page]);

  const atFirst = state.page <= 1;
  const atLast  = pageCount > 0 && state.page >= pageCount;

  const goTo = (n: number) => {
    if (!Number.isInteger(n)) return;
    const upper   = pageCount > 0 ? pageCount : n;
    const clamped = Math.max(1, Math.min(upper, n));
    controller.setPage(clamped);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Ignore key strokes when the user is typing in the jump-to-page
    // input; otherwise pressing ← inside the input would also trigger
    // navigation.
    const t = e.target as HTMLElement | null;
    if (t && t.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      goTo(state.page - 1);
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      e.preventDefault();
      goTo(state.page + 1);
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      goTo(1);
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      if (pageCount > 0) goTo(pageCount);
      return;
    }
  };

  const submitPageInput = () => {
    const n = Number(pageInputDraft);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      // Reject — snap the draft back to the real page.
      setPageInputDraft(String(state.page));
      return;
    }
    goTo(n);
  };

  return (
    <div
      ref={containerRef}
      style={SHEET}
      role="dialog"
      aria-label="PDF viewer"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header style={HEADER}>
        <span style={TITLE}>{state.assetSlug}</span>
        <div style={NAV_ROW}>
          <button
            type="button"
            style={atFirst ? NAV_BTN_DISABLED : NAV_BTN}
            onClick={() => goTo(state.page - 1)}
            disabled={atFirst}
            aria-label="Previous page"
          >‹</button>
          <input
            type="text"
            inputMode="numeric"
            style={PAGE_INPUT}
            value={pageInputDraft}
            onChange={(e) => setPageInputDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); submitPageInput(); }
            }}
            onBlur={submitPageInput}
            aria-label="Page"
          />
          {pageCount > 0 && <span>/ {pageCount}</span>}
          <button
            type="button"
            style={atLast ? NAV_BTN_DISABLED : NAV_BTN}
            onClick={() => goTo(state.page + 1)}
            disabled={atLast}
            aria-label="Next page"
          >›</button>
        </div>
        <button
          type="button"
          style={CLOSE_BTN}
          onClick={() => controller.close()}
          aria-label="Close"
        >×</button>
      </header>
      <div style={BODY}>
        <div ref={wrapperRef} style={CANVAS_WRAPPER} />
        {status === 'loading' && <div style={STATUS}>Loading page {state.page}…</div>}
        {status === 'broken'  && <div style={STATUS}>PDF unavailable.</div>}
      </div>
    </div>
  );
}

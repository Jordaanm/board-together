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
import { loadPdfjs } from '../assets/pdf/pdfjsLoader';
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

// Sheet position is `fixed` so the drag handler can use raw viewport
// coordinates regardless of how the surrounding `<AnchorLayout>`
// transform-positions its anchors. The default placement (right edge,
// vertically centred) is restored via `DEFAULT_PLACEMENT` whenever the
// user hasn't dragged it; once dragged, `position` overrides with
// absolute `left/top`.
const SHEET_BASE: React.CSSProperties = {
  position:      'fixed',
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

const DEFAULT_PLACEMENT: React.CSSProperties = {
  right:     16,
  top:       '50%',
  transform: 'translateY(-50%)',
};

const HEADER: React.CSSProperties = {
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'space-between',
  padding:        '10px 14px',
  borderBottom:   '1px solid var(--line)',
  flexShrink:     0,
  gap:            6,
  cursor:         'move',
  userSelect:     'none',
  touchAction:    'none',
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

// pdfjs text-layer container. Spans inside are positioned by the
// TextLayer class via inline styles; this wrapper just needs to sit
// flush over the rendered canvas with the same pixel dimensions, and
// keep its glyphs invisible so the user only ever sees the canvas.
// `color: transparent` keeps the glyphs paintable into the
// selection range while invisible at rest.
const TEXT_LAYER_BASE: React.CSSProperties = {
  position:       'absolute',
  inset:          0,
  overflow:       'hidden',
  lineHeight:     1,
  pointerEvents:  'auto',
  // The vendored pdfjs text-layer CSS reads these custom properties on
  // the container; ship them inline so we don't have to import the
  // upstream stylesheet.
  ['--scale-factor' as never]: 1,
};

// Stamped into a <style> tag once per mount. The pdfjs TextLayer
// positions spans absolutely; the selection-rendering rules below
// match upstream's `web/text_layer_builder.css` enough to make
// selection visible and text copyable.
const TEXT_LAYER_CSS = `
.pdf-overlay-text-layer { color: transparent; }
.pdf-overlay-text-layer ::selection { background: rgba(0, 100, 255, 0.35); }
.pdf-overlay-text-layer ::-moz-selection { background: rgba(0, 100, 255, 0.35); }
.pdf-overlay-text-layer span,
.pdf-overlay-text-layer br {
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
}
`;

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
  // User-dragged viewport position. `null` → use DEFAULT_PLACEMENT (the
  // right-edge / vertically-centred anchor). Set by header drag handlers
  // below.
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);

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
  // render replaces the wrapper's children — the previous canvas
  // and text-layer are discarded as the new ones are appended.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    let cancelled    = false;
    let activeLayer: { cancel?: () => void } | null = null;
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

      // Text layer — render after the canvas is in the DOM so the
      // container's CSS pixel size is known. The pdfjs TextLayer
      // positions spans by the page viewport; we use the same scale
      // as the canvas so they line up. Stretching the CSS dimensions
      // to match the canvas's intrinsic resolution keeps the glyph
      // boxes pixel-aligned even after the wrapper scales the canvas
      // to 100% width.
      const textLayerDiv = document.createElement('div');
      textLayerDiv.className = 'pdf-overlay-text-layer';
      Object.assign(textLayerDiv.style, TEXT_LAYER_BASE);
      // The pdfjs TextLayer positions spans in viewport pixels (i.e.
      // `canvas.width × canvas.height`). The rendered canvas itself
      // is scaled to 100% width of the wrapper, so we mirror that
      // scale on the text-layer div — keeps glyph boxes pixel-aligned
      // with the visible canvas.
      textLayerDiv.style.width           = `${canvas.width}px`;
      textLayerDiv.style.height          = `${canvas.height}px`;
      textLayerDiv.style.transformOrigin = '0 0';
      const cssScale = canvas.clientWidth > 0 ? canvas.clientWidth / canvas.width : 1;
      textLayerDiv.style.transform = `scale(${cssScale})`;
      wrapper.appendChild(textLayerDiv);

      try {
        const page          = await doc.getPage(state.page);
        if (cancelled || !wrapper.isConnected) return;
        const viewport      = page.getViewport({ scale: OVERLAY_SCALE });
        const pdfjs         = await loadPdfjs();
        if (cancelled || !wrapper.isConnected) return;
        const textContent   = await page.getTextContent();
        if (cancelled || !wrapper.isConnected) return;
        const TextLayerCtor = (pdfjs as unknown as { TextLayer: new (opts: object) => { render: () => Promise<unknown>; cancel?: () => void } }).TextLayer;
        if (TextLayerCtor) {
          const layer = new TextLayerCtor({
            textContentSource: textContent,
            container:         textLayerDiv,
            viewport,
          });
          activeLayer = layer;
          await layer.render();
        }
      } catch {
        // Text layer is non-essential — failing it shouldn't break the
        // canvas render. Leave the empty text-layer div in place so
        // styles stay stable; selection just won't pick up any glyphs.
      }

      setStatus('ready');
    })();
    return () => {
      cancelled = true;
      activeLayer?.cancel?.();
    };
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

  // Drag-to-reposition. The header is the handle; child buttons + input
  // bail out so clicking them doesn't initiate a drag. While dragging,
  // pointer capture keeps the move/up events flowing to the header even
  // if the cursor leaves it. Position is local to the SheetBody instance
  // — closing + re-opening the controller resets to the default anchor.
  const startDragInfo = useRef<{ pointerId: number; startClientX: number; startClientY: number; startX: number; startY: number } | null>(null);

  const onHeaderPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    // jsdom doesn't implement PointerEvent, so `e.button` arrives
    // undefined under fireEvent. Treat undefined as "primary"; only
    // bail when a real non-zero button is set (right-click / middle).
    if (typeof e.button === 'number' && e.button !== 0) return;
    // Don't hijack pointerdowns destined for the nav controls / close /
    // page input — those handle their own clicks.
    const t = e.target as HTMLElement | null;
    if (t && t.closest('button, input')) return;
    const sheet = containerRef.current;
    if (!sheet) return;
    const rect = sheet.getBoundingClientRect();
    startDragInfo.current = {
      pointerId:    e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX:       rect.left,
      startY:       rect.top,
    };
    // setPointerCapture isn't implemented in jsdom; guard so tests
    // that don't stub it don't throw.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch { /* unsupported environment */ }
    e.preventDefault();
  };

  const onHeaderPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const drag = startDragInfo.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    const sheet = containerRef.current;
    const w = sheet?.offsetWidth  ?? 480;
    const h = sheet?.offsetHeight ?? 200;
    // Clamp so at least a 40px strip of the sheet stays inside the
    // viewport — prevents the user from losing the panel off-screen.
    const minVisible = 40;
    const clampedX = Math.max(minVisible - w, Math.min(window.innerWidth  - minVisible, drag.startX + dx));
    const clampedY = Math.max(0,              Math.min(window.innerHeight - minVisible, drag.startY + dy));
    setPosition({ x: clampedX, y: clampedY });
  };

  const onHeaderPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    const drag = startDragInfo.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    startDragInfo.current = null;
    try {
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch { /* unsupported environment */ }
  };

  const placement: React.CSSProperties = position
    ? { left: position.x, top: position.y }
    : DEFAULT_PLACEMENT;

  return (
    <div
      ref={containerRef}
      style={{ ...SHEET_BASE, ...placement }}
      role="dialog"
      aria-label="PDF viewer"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <style>{TEXT_LAYER_CSS}</style>
      <header
        style={HEADER}
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
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

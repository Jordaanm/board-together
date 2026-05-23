// Per-viewer slide-out sheet that shows the open-in-overlay PDF page
// at higher DPI than the in-world face. Mounted at the
// `middle-right` AnchorLayout anchor; non-modal so the 3D canvas
// stays interactive while it's open. Esc and the X button close.
//
// Issue #9 wires only the image render. Issue #11 layers the pdfjs
// text layer on top of the canvas for selectable/copyable text.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'broken'>('loading');

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

  return (
    <div style={SHEET} role="dialog" aria-label="PDF viewer">
      <header style={HEADER}>
        <span style={TITLE}>{state.assetSlug} — page {state.page}</span>
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

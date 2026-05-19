// Non-modal floating panel that visualises every card in a deck in order.
// Issue #3 of planning/issues--deck-inspect.md.
//
// Pure presentation: takes the ordered card IDs from `deck.cards`, the
// host's snapshot of face/back URLs, and a callback to close. Drag-reorder
// and drag-extract belong to issues #4 and #5; this slice is read-only with
// hover preview only.

import { useEffect, useRef, useState } from 'react';
import './InspectDeckDialog.css';

interface CardSnapshot { face: string; back: string; }

interface Props {
  deckName:    string;
  cardIds:     readonly string[];
  snapshot:    Record<string, CardSnapshot>;
  onClose:     () => void;
}

const HOVER_DELAY_MS = 300;

export function InspectDeckDialog({ deckName, cardIds, snapshot, onClose }: Props) {
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const hoverTimeoutRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Escape closes; click-outside closes (pointerdown on anything outside the
  // dialog root). Both keep the 3D canvas behind interactive.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!rootRef.current || !target) return;
      if (rootRef.current.contains(target)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose]);

  const cancelHover = () => {
    if (hoverTimeoutRef.current !== null) {
      window.clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setHover(null);
  };

  const handleCellEnter = (cardId: string) => (e: React.PointerEvent) => {
    cancelHover();
    const x = e.clientX;
    const y = e.clientY;
    hoverTimeoutRef.current = window.setTimeout(() => {
      setHover({ id: cardId, x, y });
    }, HOVER_DELAY_MS);
  };

  const handleCellMove = (e: React.PointerEvent) => {
    if (hover) setHover((h) => h ? { ...h, x: e.clientX, y: e.clientY } : h);
  };

  return (
    <div
      ref={rootRef}
      className="inspect-deck-dialog"
      data-testid="inspect-deck-dialog"
      onPointerDown={cancelHover}
    >
      <div className="inspect-deck-dialog__header">
        <div className="inspect-deck-dialog__title">
          <span role="img" aria-label="search">🔍</span>
          <span>{deckName}</span>
        </div>
        <button
          type="button"
          className="inspect-deck-dialog__close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </div>
      <div className="inspect-deck-dialog__grid" data-testid="inspect-deck-dialog-grid">
        {cardIds.map((id) => {
          const snap = snapshot[id];
          const face = snap?.face;
          return (
            <div
              key={id}
              data-cell-id={id}
              data-testid={`inspect-deck-cell-${id}`}
              className="inspect-deck-dialog__cell"
              style={face ? { backgroundImage: `url("${face}")` } : undefined}
              onPointerEnter={handleCellEnter(id)}
              onPointerMove={handleCellMove}
              onPointerLeave={cancelHover}
            >
              {!face && (
                <div className="inspect-deck-dialog__cell-fallback">
                  {id.slice(0, 6)}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {hover && (
        <div
          className="inspect-deck-dialog__hover-preview"
          data-testid="inspect-deck-hover-preview"
          style={{
            left: hover.x + 12,
            top:  hover.y + 12,
            backgroundImage: snapshot[hover.id]?.face
              ? `url("${snapshot[hover.id].face}")`
              : undefined,
          }}
        />
      )}
    </div>
  );
}

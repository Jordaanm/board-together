// Non-modal floating panel that visualises every card in a deck in order.
// Issue #3 of planning/issues--deck-inspect.md. Issue #4 adds in-grid drag-
// reorder via the pure `inspectDragMachine` reducer plus a 2D ghost and a
// drop indicator. Issue #5 will wire an `onExtract` outside-grid callback.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  initialState,
  reduce,
  type DragState,
} from '../entity/components/inspectDragMachine';
import './InspectDeckDialog.css';

interface CardSnapshot { face: string; back: string; }

interface Props {
  deckName:    string;
  cardIds:     readonly string[];
  snapshot:    Record<string, CardSnapshot>;
  onClose:     () => void;
  // Issue #4 — commit a reorder. `newOrder` is a permutation of `cardIds`.
  onReorder?:  (newOrder: string[]) => void;
  // Issue #5 — commit an extract. Receives the screen coordinates of the
  // pointerup so the caller can run a table raycast.
  onExtract?:  (cardId: string, clientX: number, clientY: number) => void;
}

const HOVER_DELAY_MS = 300;

export function InspectDeckDialog({ deckName, cardIds, snapshot, onClose, onReorder, onExtract }: Props) {
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const hoverTimeoutRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Drag state. Held in a ref so window-level pointer handlers can mutate it
  // without going through a render cycle; mirror it into React state purely
  // for ghost / drop-indicator rendering.
  const dragRef = useRef<DragState>(initialState());
  const [ghost, setGhost] = useState<{ cardId: string; x: number; y: number } | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  // Capture the latest cardIds for window listeners that outlive a render.
  const cardIdsRef = useRef(cardIds);
  cardIdsRef.current = cardIds;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const onExtractRef = useRef(onExtract);
  onExtractRef.current = onExtract;

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
    if (dragRef.current.kind === 'dragging') return;  // suppress hover while dragging
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

  // Compute the gap index (0..n) closest to the cursor by walking visible
  // cells in DOM order. The gap before cell `i` corresponds to insertion at
  // index `i`; releasing past the last cell yields `n`.
  const computeDropIdx = useCallback((clientX: number, clientY: number): number => {
    const grid = gridRef.current;
    if (!grid) return 0;
    const cells = Array.from(grid.querySelectorAll<HTMLElement>('[data-cell-id]'));
    if (cells.length === 0) return 0;
    let best = cells.length;
    let bestDist = Infinity;
    for (let i = 0; i < cells.length; i++) {
      const r = cells[i].getBoundingClientRect();
      // Gap to the LEFT of cell i, at the cell's vertical mid-line.
      const gapX = r.left;
      const gapY = r.top + r.height / 2;
      const d = Math.hypot(clientX - gapX, clientY - gapY);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    // Tail-gap (to the right of the last cell on its row).
    const last = cells[cells.length - 1].getBoundingClientRect();
    const gapX = last.right;
    const gapY = last.top + last.height / 2;
    const d = Math.hypot(clientX - gapX, clientY - gapY);
    if (d < bestDist) best = cells.length;
    return best;
  }, []);

  const isInsideGrid = useCallback((clientX: number, clientY: number): boolean => {
    const grid = gridRef.current;
    if (!grid) return false;
    const r = grid.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }, []);

  const handleCellPointerDown = (cardId: string, originIdx: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    cancelHover();
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    const step = reduce(dragRef.current, {
      kind:      'pointerdown',
      cardId,
      originIdx,
      x:         e.clientX,
      y:         e.clientY,
      offsetX:   e.clientX - rect.left,
      offsetY:   e.clientY - rect.top,
    });
    dragRef.current = step.next;

    const onMove = (ev: PointerEvent) => {
      const moved = reduce(dragRef.current, { kind: 'pointermove', x: ev.clientX, y: ev.clientY });
      dragRef.current = moved.next;
      if (moved.next.kind !== 'dragging' || !moved.next.exceededThreshold) return;
      setGhost({ cardId: moved.next.cardId, x: ev.clientX, y: ev.clientY });
      if (isInsideGrid(ev.clientX, ev.clientY)) {
        setDropIdx(computeDropIdx(ev.clientX, ev.clientY));
      } else {
        setDropIdx(null);
      }
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup',   onUp);
      const cur = dragRef.current;
      const inside = isInsideGrid(ev.clientX, ev.clientY);
      const up = reduce(cur, { kind: 'pointerup', x: ev.clientX, y: ev.clientY, insideGrid: inside });
      dragRef.current = up.next;
      setGhost(null);
      setDropIdx(null);
      if (up.effect === 'reorder' && cur.kind === 'dragging') {
        const target = computeDropIdx(ev.clientX, ev.clientY);
        const order = applyReorder(cardIdsRef.current, cur.originIdx, target);
        if (order && !arraysEqual(order, cardIdsRef.current)) {
          onReorderRef.current?.(order);
        }
      } else if (up.effect === 'extract' && cur.kind === 'dragging') {
        onExtractRef.current?.(cur.cardId, ev.clientX, ev.clientY);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup',   onUp);
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
      <div
        ref={gridRef}
        className="inspect-deck-dialog__grid"
        data-testid="inspect-deck-dialog-grid"
      >
        {cardIds.map((id, idx) => {
          const snap = snapshot[id];
          const face = snap?.face;
          return (
            <div
              key={id}
              data-cell-id={id}
              data-cell-idx={idx}
              data-testid={`inspect-deck-cell-${id}`}
              className="inspect-deck-dialog__cell"
              style={face ? { backgroundImage: `url("${face}")` } : undefined}
              onPointerEnter={handleCellEnter(id)}
              onPointerMove={handleCellMove}
              onPointerLeave={cancelHover}
              onPointerDown={handleCellPointerDown(id, idx)}
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
      {ghost && (
        <DragGhost
          face={snapshot[ghost.cardId]?.face ?? ''}
          x={ghost.x}
          y={ghost.y}
        />
      )}
      {dropIdx !== null && (
        <DropIndicator gridRef={gridRef} cellCount={cardIds.length} idx={dropIdx} />
      )}
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

function DragGhost({ face, x, y }: { face: string; x: number; y: number }) {
  return (
    <div
      className="inspect-deck-dialog__ghost"
      data-testid="inspect-deck-ghost"
      style={{
        left: x,
        top:  y,
        backgroundImage: face ? `url("${face}")` : undefined,
      }}
    />
  );
}

function DropIndicator({
  gridRef, cellCount, idx,
}: {
  gridRef: React.RefObject<HTMLDivElement>;
  cellCount: number;
  idx: number;
}) {
  const grid = gridRef.current;
  if (!grid || cellCount === 0) return null;
  const cells = Array.from(grid.querySelectorAll<HTMLElement>('[data-cell-id]'));
  if (cells.length === 0) return null;
  let left: number;
  let top:  number;
  let height: number;
  if (idx >= cells.length) {
    const r = cells[cells.length - 1].getBoundingClientRect();
    left = r.right;
    top  = r.top;
    height = r.height;
  } else {
    const r = cells[idx].getBoundingClientRect();
    left = r.left;
    top  = r.top;
    height = r.height;
  }
  return (
    <div
      className="inspect-deck-dialog__drop-indicator"
      data-testid="inspect-deck-drop-indicator"
      style={{ left: left - 1, top, height }}
    />
  );
}

// Pure helper. Moves the card at `from` to insertion index `to`. `to` is a
// gap index in the original array (0..n). Returns null when the move is a
// no-op (e.g. dragging onto the same slot or its right-hand gap).
export function applyReorder(cards: readonly string[], from: number, to: number): string[] | null {
  if (from < 0 || from >= cards.length) return null;
  // Dropping into the gap immediately before or after the dragged card is a
  // no-op — both leave the order unchanged.
  if (to === from || to === from + 1) return null;
  const next = [...cards];
  const [moved] = next.splice(from, 1);
  // After splice the indices past `from` shift by -1.
  const insertAt = to > from ? to - 1 : to;
  next.splice(insertAt, 0, moved);
  return next;
}

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

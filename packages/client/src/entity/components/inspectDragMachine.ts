// Pure drag-state reducer for the InspectDeckDialog. Issue #1 of
// planning/issues--deck-inspect.md.
//
// No DOM, no THREE, no React — just `(state, event) → next state + side-effect
// tag`. The dialog wires this to pointer events on its grid cells. Side-effect
// tags are interpreted by the dialog: 'reorder' commits a permutation,
// 'extract' performs a table raycast and fires an extract RPC, 'cancel' snaps
// the ghost back to its origin, 'none' is a no-op.

export const DRAG_THRESHOLD_PX = 4;

export interface IdleState { kind: 'idle'; }

export interface DraggingState {
  kind:     'dragging';
  cardId:   string;
  originIdx: number;
  // Pointer screen coordinates at down — used to compute the threshold.
  downX:    number;
  downY:    number;
  // Cell offset (cursor relative to the origin cell's top-left at down time).
  // The dialog passes this through so it can render the ghost anchored to the
  // cursor in the same way.
  offsetX:  number;
  offsetY:  number;
  // Whether the pointer has crossed the threshold since press. Until it does
  // we treat any pointerup as a cancel (so a stationary click is never a
  // commit).
  exceededThreshold: boolean;
}

export type DragState = IdleState | DraggingState;

export type DragEvent =
  | { kind: 'pointerdown'; cardId: string; originIdx: number; x: number; y: number; offsetX: number; offsetY: number }
  | { kind: 'pointermove'; x: number; y: number }
  | { kind: 'pointerup';   x: number; y: number; insideGrid: boolean };

export type SideEffect = 'reorder' | 'extract' | 'cancel' | 'none';

export interface Step {
  next:   DragState;
  effect: SideEffect;
}

export function initialState(): DragState {
  return { kind: 'idle' };
}

export function reduce(state: DragState, event: DragEvent): Step {
  if (state.kind === 'idle') {
    if (event.kind === 'pointerdown') {
      return {
        next: {
          kind:      'dragging',
          cardId:    event.cardId,
          originIdx: event.originIdx,
          downX:     event.x,
          downY:     event.y,
          offsetX:   event.offsetX,
          offsetY:   event.offsetY,
          exceededThreshold: false,
        },
        effect: 'none',
      };
    }
    return { next: state, effect: 'none' };
  }

  // state.kind === 'dragging'
  if (event.kind === 'pointermove') {
    if (state.exceededThreshold) return { next: state, effect: 'none' };
    const dx = event.x - state.downX;
    const dy = event.y - state.downY;
    const exceeded = Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX;
    if (!exceeded) return { next: state, effect: 'none' };
    return { next: { ...state, exceededThreshold: true }, effect: 'none' };
  }

  if (event.kind === 'pointerup') {
    if (!state.exceededThreshold) {
      return { next: initialState(), effect: 'cancel' };
    }
    return {
      next:   initialState(),
      effect: event.insideGrid ? 'reorder' : 'extract',
    };
  }

  // pointerdown while already dragging — replace the press (defensive; the
  // dialog should suppress this, but the SM stays well-defined either way).
  if (event.kind === 'pointerdown') {
    return {
      next: {
        kind:      'dragging',
        cardId:    event.cardId,
        originIdx: event.originIdx,
        downX:     event.x,
        downY:     event.y,
        offsetX:   event.offsetX,
        offsetY:   event.offsetY,
        exceededThreshold: false,
      },
      effect: 'none',
    };
  }

  return { next: state, effect: 'none' };
}

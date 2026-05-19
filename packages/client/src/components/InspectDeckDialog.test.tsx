// @vitest-environment jsdom
import { describe, test, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { InspectDeckDialog, applyReorder } from './InspectDeckDialog';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const SNAPSHOT = {
  c1: { face: 'face-c1.png', back: 'back-c1.png' },
  c2: { face: 'face-c2.png', back: 'back-c2.png' },
};

describe('InspectDeckDialog', () => {
  test('renders one cell per card in deck order', () => {
    const { getByTestId } = render(
      <InspectDeckDialog
        deckName="My Deck"
        cardIds={['c1', 'c2']}
        snapshot={SNAPSHOT}
        onClose={() => {}}
      />,
    );
    const grid = getByTestId('inspect-deck-dialog-grid');
    expect(grid.children).toHaveLength(2);
    expect(grid.children[0].getAttribute('data-cell-id')).toBe('c1');
    expect(grid.children[1].getAttribute('data-cell-id')).toBe('c2');
  });

  test('cell exposes its card id via data attribute and testid', () => {
    const { getByTestId } = render(
      <InspectDeckDialog
        deckName="My Deck"
        cardIds={['c1']}
        snapshot={SNAPSHOT}
        onClose={() => {}}
      />,
    );
    // The actual face URL is resolved asynchronously through the asset
    // service (Three's TextureLoader doesn't settle in jsdom), so we only
    // check that the cell is wired up correctly.
    expect(getByTestId('inspect-deck-cell-c1').getAttribute('data-cell-id')).toBe('c1');
  });

  test('Escape key fires onClose', () => {
    const onClose = vi.fn();
    render(
      <InspectDeckDialog
        deckName="My Deck"
        cardIds={['c1']}
        snapshot={SNAPSHOT}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('clicking the × button fires onClose', () => {
    const onClose = vi.fn();
    const { getByLabelText } = render(
      <InspectDeckDialog
        deckName="My Deck"
        cardIds={['c1']}
        snapshot={SNAPSHOT}
        onClose={onClose}
      />,
    );
    fireEvent.click(getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('hover preview shows up after 300ms', () => {
    vi.useFakeTimers();
    const { getByTestId, queryByTestId } = render(
      <InspectDeckDialog
        deckName="My Deck"
        cardIds={['c1']}
        snapshot={SNAPSHOT}
        onClose={() => {}}
      />,
    );
    const cell = getByTestId('inspect-deck-cell-c1');
    expect(queryByTestId('inspect-deck-hover-preview')).toBeNull();
    fireEvent.pointerEnter(cell, { clientX: 50, clientY: 60 });
    act(() => { vi.advanceTimersByTime(299); });
    expect(queryByTestId('inspect-deck-hover-preview')).toBeNull();
    act(() => { vi.advanceTimersByTime(2); });
    expect(queryByTestId('inspect-deck-hover-preview')).not.toBeNull();
  });

  test('applyReorder moves to front', () => {
    expect(applyReorder(['a', 'b', 'c', 'd'], 2, 0)).toEqual(['c', 'a', 'b', 'd']);
  });

  test('applyReorder moves to end', () => {
    expect(applyReorder(['a', 'b', 'c', 'd'], 0, 4)).toEqual(['b', 'c', 'd', 'a']);
  });

  test('applyReorder moves within', () => {
    expect(applyReorder(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'a', 'c', 'd']);
  });

  test('applyReorder same-slot drop returns null', () => {
    expect(applyReorder(['a', 'b', 'c'], 1, 1)).toBeNull();
    expect(applyReorder(['a', 'b', 'c'], 1, 2)).toBeNull();
  });

  test('applyReorder out-of-range from returns null', () => {
    expect(applyReorder(['a', 'b', 'c'], 5, 0)).toBeNull();
    expect(applyReorder(['a', 'b', 'c'], -1, 0)).toBeNull();
  });

  test('pointerleave cancels a pending hover before it fires', () => {
    vi.useFakeTimers();
    const { getByTestId, queryByTestId } = render(
      <InspectDeckDialog
        deckName="My Deck"
        cardIds={['c1']}
        snapshot={SNAPSHOT}
        onClose={() => {}}
      />,
    );
    const cell = getByTestId('inspect-deck-cell-c1');
    fireEvent.pointerEnter(cell, { clientX: 50, clientY: 60 });
    fireEvent.pointerLeave(cell);
    act(() => { vi.advanceTimersByTime(400); });
    expect(queryByTestId('inspect-deck-hover-preview')).toBeNull();
  });
});

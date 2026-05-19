import { describe, test, expect } from 'vitest';
import { cellStateOf, nextCellAction, type CellAction } from './deckCellState';

describe('cellStateOf', () => {
  test('returns back for the backIndex cell', () => {
    expect(cellStateOf(3, 3, new Set())).toBe('back');
  });

  test('returns none for an excluded cell', () => {
    expect(cellStateOf(2, 5, new Set([2]))).toBe('none');
  });

  test('returns face for a cell that is neither back nor excluded', () => {
    expect(cellStateOf(1, 5, new Set([2, 7]))).toBe('face');
  });

  test('returns face when backIndex is null and cell is not excluded', () => {
    expect(cellStateOf(0, null, new Set())).toBe('face');
    expect(cellStateOf(0, null, new Set([3]))).toBe('face');
  });

  test('returns none when backIndex is null and cell is excluded', () => {
    expect(cellStateOf(3, null, new Set([3]))).toBe('none');
  });

  test('back wins over none if a cell were somehow in both (defensive)', () => {
    expect(cellStateOf(4, 4, new Set([4]))).toBe('back');
  });
});

describe('nextCellAction', () => {
  test('face + back-occupied → excludeAdd', () => {
    expect(nextCellAction('face', true)).toEqual({ kind: 'excludeAdd' });
  });

  test('face + no-back → setBack', () => {
    expect(nextCellAction('face', false)).toEqual({ kind: 'setBack' });
  });

  test('none + back-occupied → excludeRemove', () => {
    expect(nextCellAction('none', true)).toEqual({ kind: 'excludeRemove' });
  });

  test('none + no-back → excludeRemove (None → Face per the no-back cycle)', () => {
    expect(nextCellAction('none', false)).toEqual({ kind: 'excludeRemove' });
  });

  test('back → vacateBack', () => {
    expect(nextCellAction('back', true)).toEqual({ kind: 'vacateBack' });
  });
});

// Small in-test simulator: composes an action against a (backIndex, excluded)
// pair. Mirrors what the modal does in setState, kept tiny so we can verify
// sequenced behavior without exercising React.
interface Sim {
  backIndex: number | null;
  excluded:  Set<number>;
}

function apply(sim: Sim, i: number, action: CellAction): Sim {
  const next: Sim = { backIndex: sim.backIndex, excluded: new Set(sim.excluded) };
  switch (action.kind) {
    case 'setBack':
      next.backIndex = i;
      next.excluded.delete(i);
      return next;
    case 'excludeAdd':
      next.excluded.add(i);
      return next;
    case 'excludeRemove':
      next.excluded.delete(i);
      return next;
    case 'vacateBack':
      next.backIndex = null;
      next.excluded.add(i);
      return next;
  }
}

function click(sim: Sim, i: number): Sim {
  const state  = cellStateOf(i, sim.backIndex, sim.excluded);
  const action = nextCellAction(state, sim.backIndex !== null);
  return apply(sim, i, action);
}

describe('sequenced behavior', () => {
  test('Back cell recovers via Back → None → Face → Back on the same cell', () => {
    let sim: Sim = { backIndex: 5, excluded: new Set() };

    sim = click(sim, 5);
    expect(cellStateOf(5, sim.backIndex, sim.excluded)).toBe('none');
    expect(sim.backIndex).toBeNull();

    sim = click(sim, 5);
    expect(cellStateOf(5, sim.backIndex, sim.excluded)).toBe('face');
    expect(sim.backIndex).toBeNull();

    sim = click(sim, 5);
    expect(cellStateOf(5, sim.backIndex, sim.excluded)).toBe('back');
    expect(sim.backIndex).toBe(5);
  });

  test('vacating the Back slot lets any other Face cell claim Back on next click', () => {
    let sim: Sim = { backIndex: 5, excluded: new Set() };

    sim = click(sim, 5);
    expect(sim.backIndex).toBeNull();

    sim = click(sim, 2);
    expect(sim.backIndex).toBe(2);
    expect(cellStateOf(2, sim.backIndex, sim.excluded)).toBe('back');
    expect(cellStateOf(5, sim.backIndex, sim.excluded)).toBe('none');
  });

  test('picking a new Back clears the new cell from excluded (no greyscale flash)', () => {
    let sim: Sim = { backIndex: 5, excluded: new Set([2]) };

    sim = click(sim, 5);
    expect(sim.backIndex).toBeNull();
    expect(sim.excluded.has(5)).toBe(true);
    expect(sim.excluded.has(2)).toBe(true);

    sim = click(sim, 2);
    expect(cellStateOf(2, sim.backIndex, sim.excluded)).toBe('face');

    sim = click(sim, 2);
    expect(sim.backIndex).toBe(2);
    expect(sim.excluded.has(2)).toBe(false);
  });

  test('Face↔None two-state cycle on non-Back cells while a Back is held', () => {
    let sim: Sim = { backIndex: 5, excluded: new Set() };

    sim = click(sim, 1);
    expect(cellStateOf(1, sim.backIndex, sim.excluded)).toBe('none');
    sim = click(sim, 1);
    expect(cellStateOf(1, sim.backIndex, sim.excluded)).toBe('face');
    sim = click(sim, 1);
    expect(cellStateOf(1, sim.backIndex, sim.excluded)).toBe('none');

    expect(sim.backIndex).toBe(5);
  });
});

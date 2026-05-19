// Pure tri-state cycle rules for the Generate Deck modal's cell grid.
//
// Each cell is in one of three states: 'face' (becomes a card), 'back' (the
// shared card back), or 'none' (skipped). Only one cell is 'back' at a time.
// Cycle order depends on whether a Back is currently set:
//   - With a Back set, non-Back cells cycle face ↔ none.
//   - Without a Back set, non-Back cells cycle face → back → none → face.
//   - The Back cell itself cycles back → none (vacates the slot); the next
//     click on that cell follows the no-back rule (none → face, then back).
//
// State lives in the modal as `backIndex: number | null` + `excluded: Set<number>`.
// `nextCellAction` returns a structured transition the modal applies to those.

export type CellState = 'face' | 'back' | 'none';

export type CellAction =
  | { kind: 'setBack' }
  | { kind: 'excludeAdd' }
  | { kind: 'excludeRemove' }
  | { kind: 'vacateBack' };

export function cellStateOf(
  i:         number,
  backIndex: number | null,
  excluded:  ReadonlySet<number>,
): CellState {
  if (i === backIndex)  return 'back';
  if (excluded.has(i))  return 'none';
  return 'face';
}

export function nextCellAction(state: CellState, backOccupied: boolean): CellAction {
  switch (state) {
    case 'face': return backOccupied ? { kind: 'excludeAdd' } : { kind: 'setBack' };
    case 'none': return { kind: 'excludeRemove' };
    case 'back': return { kind: 'vacateBack' };
  }
}

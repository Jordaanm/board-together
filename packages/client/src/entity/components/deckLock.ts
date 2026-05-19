// Inspect-lock predicate. Issue #1 of planning/issues--deck-inspect.md.
// Pure read against a `searchLockedBy` slot — kept separate from DeckComponent
// so DeckService / MergeService can consult it without re-importing the
// component class through the same gate.

import { type SeatIndex } from '../../seats/SeatLayout';

export interface DeckLockState {
  searchLockedBy: SeatIndex | null;
}

// True when the deck's inspect lock is held *against* the caller — i.e. when
// some other seat is inspecting it. Null lock or own-seat lock returns false
// (the caller is free to mutate).
export function isLockedAgainst(state: DeckLockState, seat: SeatIndex | null): boolean {
  if (state.searchLockedBy === null) return false;
  if (state.searchLockedBy === seat) return false;
  return true;
}

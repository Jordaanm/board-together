// SelectionStore — local-per-client multi-selection container.
//
// Single source of truth for the click matrix: `applySelectionClick` is a
// pure reducer (plain / shift / ctrl × in / out / empty). The store wraps
// a `Set<string>` plus a pubsub for React consumers.

export type SelectionClickModifier = 'plain' | 'shift' | 'ctrl';

export interface SelectionClickInput {
  state:    ReadonlySet<string>;
  targetId: string | null;
  modifier: SelectionClickModifier;
}

// Returns a brand-new Set; never mutates input. Empty-space (`targetId ===
// null`) shift/ctrl clicks preserve the current selection — an accidental
// miss during a mid-build sequence should not drop what the user has.
export function applySelectionClick(input: SelectionClickInput): Set<string> {
  const { state, targetId, modifier } = input;
  if (targetId === null) {
    if (modifier === 'plain') return new Set();
    return new Set(state);
  }
  const inSelection = state.has(targetId);
  if (modifier === 'plain') {
    return inSelection ? new Set(state) : new Set([targetId]);
  }
  if (modifier === 'shift') {
    return inSelection ? new Set(state) : new Set([...state, targetId]);
  }
  if (inSelection) {
    const next = new Set(state);
    next.delete(targetId);
    return next;
  }
  return new Set([...state, targetId]);
}

export class SelectionStore {
  private _state    = new Set<string>();
  private listeners = new Set<() => void>();

  has(id: string): boolean       { return this._state.has(id); }
  size(): number                 { return this._state.size; }
  ids(): ReadonlySet<string>     { return this._state; }

  clear(): void {
    if (this._state.size === 0) return;
    this._state = new Set();
    this.emit();
  }

  replace(id: string): void {
    if (this._state.size === 1 && this._state.has(id)) return;
    this._state = new Set([id]);
    this.emit();
  }

  add(id: string): void {
    if (this._state.has(id)) return;
    const next = new Set(this._state);
    next.add(id);
    this._state = next;
    this.emit();
  }

  remove(id: string): void {
    if (!this._state.has(id)) return;
    const next = new Set(this._state);
    next.delete(id);
    this._state = next;
    this.emit();
  }

  // Bulk replace — typically called with the output of `applySelectionClick`.
  // No-op (no emit) when membership is unchanged.
  setState(next: ReadonlySet<string>): void {
    if (this.sameMembership(next)) return;
    this._state = new Set(next);
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private sameMembership(other: ReadonlySet<string>): boolean {
    if (other.size !== this._state.size) return false;
    for (const id of other) if (!this._state.has(id)) return false;
    return true;
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

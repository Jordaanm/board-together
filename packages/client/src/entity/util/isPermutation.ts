// Pure multiset-equality predicate. Shared by HandComponent.reorderContents
// and DeckService.reorderDeck (issue #1 of planning/issues--deck-inspect.md).
//
// True when `after` contains exactly the same elements as `before`, with the
// same multiplicities (so duplicates are honoured). Order is ignored.

export function isPermutation<T>(before: readonly T[], after: readonly T[]): boolean {
  if (before.length !== after.length) return false;
  if (before.length === 0) return true;
  const counts = new Map<T, number>();
  for (const x of before) counts.set(x, (counts.get(x) ?? 0) + 1);
  for (const y of after) {
    const c = counts.get(y);
    if (c === undefined || c === 0) return false;
    counts.set(y, c - 1);
  }
  return true;
}

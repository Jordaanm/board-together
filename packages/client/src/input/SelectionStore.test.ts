import { describe, test, expect } from 'vitest';
import { applySelectionClick, applySelectionMarquee, SelectionStore } from './SelectionStore';

describe('applySelectionClick — full click matrix', () => {
  // ── empty target (null) ────────────────────────────────────────────────
  test('plain + empty → clears selection', () => {
    const next = applySelectionClick({
      state: new Set(['a', 'b']), targetId: null, modifier: 'plain',
    });
    expect(next.size).toBe(0);
  });
  test('shift + empty → no mutation', () => {
    const next = applySelectionClick({
      state: new Set(['a', 'b']), targetId: null, modifier: 'shift',
    });
    expect([...next].sort()).toEqual(['a', 'b']);
  });
  test('ctrl + empty → no mutation', () => {
    const next = applySelectionClick({
      state: new Set(['a', 'b']), targetId: null, modifier: 'ctrl',
    });
    expect([...next].sort()).toEqual(['a', 'b']);
  });

  // ── target out-of-selection ────────────────────────────────────────────
  test('plain + out-of-selection → replaces', () => {
    const next = applySelectionClick({
      state: new Set(['a', 'b']), targetId: 'c', modifier: 'plain',
    });
    expect([...next]).toEqual(['c']);
  });
  test('shift + out-of-selection → adds', () => {
    const next = applySelectionClick({
      state: new Set(['a']), targetId: 'b', modifier: 'shift',
    });
    expect([...next].sort()).toEqual(['a', 'b']);
  });
  test('ctrl + out-of-selection → adds (toggle)', () => {
    const next = applySelectionClick({
      state: new Set(['a']), targetId: 'b', modifier: 'ctrl',
    });
    expect([...next].sort()).toEqual(['a', 'b']);
  });

  // ── target in-selection ────────────────────────────────────────────────
  test('plain + in-selection → no mutation', () => {
    const next = applySelectionClick({
      state: new Set(['a', 'b']), targetId: 'a', modifier: 'plain',
    });
    expect([...next].sort()).toEqual(['a', 'b']);
  });
  test('shift + in-selection → no mutation', () => {
    const next = applySelectionClick({
      state: new Set(['a', 'b']), targetId: 'a', modifier: 'shift',
    });
    expect([...next].sort()).toEqual(['a', 'b']);
  });
  test('ctrl + in-selection → removes (toggle)', () => {
    const next = applySelectionClick({
      state: new Set(['a', 'b']), targetId: 'a', modifier: 'ctrl',
    });
    expect([...next]).toEqual(['b']);
  });

  test('returns a new Set — never mutates the input', () => {
    const state = new Set(['a']);
    const next = applySelectionClick({ state, targetId: 'b', modifier: 'shift' });
    expect(next).not.toBe(state);
    expect([...state]).toEqual(['a']);
  });
});

describe('applySelectionMarquee — release-time matrix', () => {
  test('plain replaces selection with candidates', () => {
    const next = applySelectionMarquee({
      state:      new Set(['a', 'b']),
      candidates: new Set(['c', 'd']),
      modifier:   'plain',
    });
    expect([...next].sort()).toEqual(['c', 'd']);
  });

  test('plain with empty candidates clears the selection', () => {
    const next = applySelectionMarquee({
      state:      new Set(['a', 'b']),
      candidates: new Set(),
      modifier:   'plain',
    });
    expect(next.size).toBe(0);
  });

  test('shift unions candidates into the existing selection', () => {
    const next = applySelectionMarquee({
      state:      new Set(['a', 'b']),
      candidates: new Set(['b', 'c']),
      modifier:   'shift',
    });
    expect([...next].sort()).toEqual(['a', 'b', 'c']);
  });

  test('shift with empty candidates is a no-op', () => {
    const next = applySelectionMarquee({
      state:      new Set(['a']),
      candidates: new Set(),
      modifier:   'shift',
    });
    expect([...next]).toEqual(['a']);
  });

  test('ctrl toggles each candidate', () => {
    const next = applySelectionMarquee({
      state:      new Set(['a', 'b']),
      candidates: new Set(['b', 'c']),
      modifier:   'ctrl',
    });
    expect([...next].sort()).toEqual(['a', 'c']);
  });

  test('ctrl with empty candidates is a no-op', () => {
    const next = applySelectionMarquee({
      state:      new Set(['a']),
      candidates: new Set(),
      modifier:   'ctrl',
    });
    expect([...next]).toEqual(['a']);
  });

  test('never mutates the input state or candidate set', () => {
    const state      = new Set(['a']);
    const candidates = new Set(['b']);
    const next = applySelectionMarquee({ state, candidates, modifier: 'shift' });
    expect(next).not.toBe(state);
    expect([...state]).toEqual(['a']);
    expect([...candidates]).toEqual(['b']);
  });
});

describe('SelectionStore — pubsub + helpers', () => {
  test('replace/add/remove emit only when membership changes', () => {
    const store = new SelectionStore();
    let calls = 0;
    store.subscribe(() => { calls += 1; });

    store.replace('a'); expect(calls).toBe(1);
    store.replace('a'); expect(calls).toBe(1); // idempotent
    store.add('a');     expect(calls).toBe(1); // already present
    store.add('b');     expect(calls).toBe(2);
    store.remove('c');  expect(calls).toBe(2); // not present
    store.remove('a');  expect(calls).toBe(3);
    expect([...store.ids()]).toEqual(['b']);
  });

  test('setState replaces wholesale; same-membership is a no-op', () => {
    const store = new SelectionStore();
    let calls = 0;
    store.subscribe(() => { calls += 1; });
    store.setState(new Set(['a', 'b']));
    expect(calls).toBe(1);
    store.setState(new Set(['b', 'a'])); // same membership, different order
    expect(calls).toBe(1);
    store.setState(new Set(['a']));
    expect(calls).toBe(2);
    expect([...store.ids()]).toEqual(['a']);
  });

  test('clear is idempotent on empty', () => {
    const store = new SelectionStore();
    let calls = 0;
    store.subscribe(() => { calls += 1; });
    store.clear();
    expect(calls).toBe(0);
    store.replace('a');
    store.clear();
    expect(calls).toBe(2);
    expect(store.size()).toBe(0);
  });
});

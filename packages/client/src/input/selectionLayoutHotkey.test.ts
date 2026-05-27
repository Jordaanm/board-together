import { describe, test, expect } from 'vitest';
import { resolveLayoutHotkey } from './selectionLayoutHotkey';

const IDLE = { textInputFocused: false, activeGesture: false };

describe('resolveLayoutHotkey', () => {
  test('bare digit 1..9 returns the column count', () => {
    for (let n = 1; n <= 9; n++) {
      expect(resolveLayoutHotkey({ key: String(n), repeat: false }, IDLE)).toBe(n);
    }
  });

  test('digit 0 returns null', () => {
    expect(resolveLayoutHotkey({ key: '0', repeat: false }, IDLE)).toBeNull();
  });

  test('non-digit returns null', () => {
    expect(resolveLayoutHotkey({ key: 'a',     repeat: false }, IDLE)).toBeNull();
    expect(resolveLayoutHotkey({ key: 'Enter', repeat: false }, IDLE)).toBeNull();
  });

  test('repeat events are ignored', () => {
    expect(resolveLayoutHotkey({ key: '3', repeat: true }, IDLE)).toBeNull();
  });

  test('text-input focus suppresses', () => {
    expect(resolveLayoutHotkey({ key: '3', repeat: false }, { ...IDLE, textInputFocused: true })).toBeNull();
  });

  test('active gesture suppresses', () => {
    expect(resolveLayoutHotkey({ key: '3', repeat: false }, { ...IDLE, activeGesture: true })).toBeNull();
  });

  test('any modifier suppresses (reserved for toolbar / chords)', () => {
    expect(resolveLayoutHotkey({ key: '3', repeat: false, ctrlKey:  true }, IDLE)).toBeNull();
    expect(resolveLayoutHotkey({ key: '3', repeat: false, metaKey:  true }, IDLE)).toBeNull();
    expect(resolveLayoutHotkey({ key: '3', repeat: false, altKey:   true }, IDLE)).toBeNull();
    expect(resolveLayoutHotkey({ key: '3', repeat: false, shiftKey: true }, IDLE)).toBeNull();
  });
});

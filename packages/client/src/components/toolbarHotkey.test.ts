import { describe, test, expect } from 'vitest';
import { resolveHotkey } from './toolbarHotkey';

const CATALOGUE = [
  { id: 'grab' },
  { id: 'ping' },
  { id: 'flick' },
];

describe('resolveHotkey', () => {
  test('Ctrl+digit 1..N maps to slot order', () => {
    expect(resolveHotkey({ key: '1', repeat: false, ctrlKey: true }, CATALOGUE, false)).toBe('grab');
    expect(resolveHotkey({ key: '2', repeat: false, ctrlKey: true }, CATALOGUE, false)).toBe('ping');
    expect(resolveHotkey({ key: '3', repeat: false, ctrlKey: true }, CATALOGUE, false)).toBe('flick');
  });

  test('Meta+digit (mac) also maps to slot order', () => {
    expect(resolveHotkey({ key: '1', repeat: false, metaKey: true }, CATALOGUE, false)).toBe('grab');
    expect(resolveHotkey({ key: '3', repeat: false, metaKey: true }, CATALOGUE, false)).toBe('flick');
  });

  test('bare digit (no modifier) returns null — reserved for layout hotkey', () => {
    expect(resolveHotkey({ key: '1', repeat: false }, CATALOGUE, false)).toBeNull();
    expect(resolveHotkey({ key: '2', repeat: false }, CATALOGUE, false)).toBeNull();
    expect(resolveHotkey({ key: '3', repeat: false }, CATALOGUE, false)).toBeNull();
  });

  test('out-of-range Ctrl+digit returns null', () => {
    expect(resolveHotkey({ key: '4', repeat: false, ctrlKey: true }, CATALOGUE, false)).toBeNull();
    expect(resolveHotkey({ key: '0', repeat: false, ctrlKey: true }, CATALOGUE, false)).toBeNull();
  });

  test('non-numeric key with Ctrl returns null', () => {
    expect(resolveHotkey({ key: 'a',     repeat: false, ctrlKey: true }, CATALOGUE, false)).toBeNull();
    expect(resolveHotkey({ key: 'Enter', repeat: false, ctrlKey: true }, CATALOGUE, false)).toBeNull();
  });

  test('repeat events are ignored even with Ctrl', () => {
    expect(resolveHotkey({ key: '1', repeat: true, ctrlKey: true }, CATALOGUE, false)).toBeNull();
  });

  test('text-input focus suppresses hotkey even with Ctrl', () => {
    expect(resolveHotkey({ key: '1', repeat: false, ctrlKey: true }, CATALOGUE, true)).toBeNull();
  });

  test('empty catalogue → null for any key', () => {
    expect(resolveHotkey({ key: '1', repeat: false, ctrlKey: true }, [], false)).toBeNull();
  });
});

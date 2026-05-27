// @vitest-environment jsdom
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { load, save, STORAGE_KEY } from './storage';
import { DEFAULT_HOTKEYS, DEFAULT_PREFERENCES, type Preferences } from './types';

describe('preferences storage', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('load() returns defaults when key is missing', () => {
    expect(load()).toEqual(DEFAULT_PREFERENCES);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('load() returns defaults + warns on corrupt JSON', () => {
    localStorage.setItem(STORAGE_KEY, 'not-json{{{');
    expect(load()).toEqual(DEFAULT_PREFERENCES);
    expect(warnSpy).toHaveBeenCalled();
  });

  test('load() uses field-level default for one bad field, preserves the other', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1, darkMode: 'purple', rotateAmount: 90,
    }));
    const prefs = load();
    expect(prefs.darkMode).toBe(DEFAULT_PREFERENCES.darkMode);
    expect(prefs.rotateAmount).toBe(90);
  });

  test('load() field-level default for bad rotateAmount, preserves darkMode', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1, darkMode: 'dark', rotateAmount: -7,
    }));
    const prefs = load();
    expect(prefs.darkMode).toBe('dark');
    expect(prefs.rotateAmount).toBe(DEFAULT_PREFERENCES.rotateAmount);
  });

  test('load() returns defaults + warns on future version', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 2, darkMode: 'dark', rotateAmount: 90,
    }));
    expect(load()).toEqual(DEFAULT_PREFERENCES);
    expect(warnSpy).toHaveBeenCalled();
  });

  test('save() then load() round-trips a valid blob', () => {
    const prefs: Preferences = {
      version: 1, darkMode: 'light', rotateAmount: 30,
      hotkeys: { ...DEFAULT_HOTKEYS },
      discordPresenceEnabled: true,
      showFps: false,
      gridAlignment: 'camera',
    };
    save(prefs);
    expect(load()).toEqual(prefs);
  });

  test('load() on a pre-hotkeys blob fills in the default hotkeys map', () => {
    // Simulates a stored blob written before issue #2 — no `hotkeys` key.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1, darkMode: 'dark', rotateAmount: 90,
    }));
    const prefs = load();
    expect(prefs.darkMode).toBe('dark');
    expect(prefs.rotateAmount).toBe(90);
    expect(prefs.hotkeys).toEqual(DEFAULT_HOTKEYS);
  });

  test('load() round-trips a custom hotkeys map written by save()', () => {
    const prefs: Preferences = {
      version: 1, darkMode: 'dark', rotateAmount: 45,
      hotkeys: {
        'flip':        'g',
        'rotate-cw':   'r',
        'rotate-ccw':  't',
        'lock-toggle': 'k',
        'roll':        '',
      },
      discordPresenceEnabled: true,
      showFps: false,
      gridAlignment: 'table',
    };
    save(prefs);
    expect(load()).toEqual(prefs);
  });

  test('load() sanitises invalid hotkey values back to defaults per-key', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1, darkMode: 'dark', rotateAmount: 45,
      hotkeys: {
        'flip':        'ff',       // too long → default
        'rotate-cw':   42,         // wrong type → default
        'rotate-ccw':  'Q',        // valid single char (lower-cased)
        'lock-toggle': '',         // valid unbound
        'roll':        'r',        // valid override
      },
    }));
    const prefs = load();
    expect(prefs.hotkeys).toEqual({
      'flip':        DEFAULT_HOTKEYS.flip,
      'rotate-cw':   DEFAULT_HOTKEYS['rotate-cw'],
      'rotate-ccw':  'q',
      'lock-toggle': '',
      'roll':        'r',
    });
  });

  test('load() falls back to default gridAlignment for an invalid value', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1, darkMode: 'dark', rotateAmount: 45,
      gridAlignment: 'lunar',
    }));
    expect(load().gridAlignment).toBe(DEFAULT_PREFERENCES.gridAlignment);
  });

  test('load() preserves a stored gridAlignment of "table"', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1, darkMode: 'dark', rotateAmount: 45,
      gridAlignment: 'table',
    }));
    expect(load().gridAlignment).toBe('table');
  });

  test('load() swallows localStorage.getItem throw', () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = function () { throw new Error('boom'); };
    try {
      expect(load()).toEqual(DEFAULT_PREFERENCES);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      Storage.prototype.getItem = orig;
    }
  });

  test('save() swallows localStorage.setItem throw', () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function () { throw new Error('quota'); };
    try {
      expect(() => save({
        version: 1, darkMode: 'dark', rotateAmount: 15,
        hotkeys: { ...DEFAULT_HOTKEYS },
        discordPresenceEnabled: true,
        showFps: false,
        gridAlignment: 'camera',
      })).not.toThrow();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      Storage.prototype.setItem = orig;
    }
  });
});

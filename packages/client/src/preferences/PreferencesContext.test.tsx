// @vitest-environment jsdom
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { PreferencesProvider } from './PreferencesContext';
import { usePreferences } from './usePreferences';
import { STORAGE_KEY } from './storage';
import { DEFAULT_HOTKEYS, DEFAULT_PREFERENCES, type Preferences } from './types';

interface FakeMQ {
  matches: boolean;
  media:   string;
  onchange: ((e: MediaQueryListEvent) => void) | null;
  addEventListener: (type: 'change', cb: (e: MediaQueryListEvent) => void) => void;
  removeEventListener: (type: 'change', cb: (e: MediaQueryListEvent) => void) => void;
  addListener: (cb: (e: MediaQueryListEvent) => void) => void;
  removeListener: (cb: (e: MediaQueryListEvent) => void) => void;
  dispatchEvent: (e: Event) => boolean;
  _listeners: Array<(e: MediaQueryListEvent) => void>;
  _fire: (matches: boolean) => void;
}

function makeMQ(initial: boolean): FakeMQ {
  const listeners: Array<(e: MediaQueryListEvent) => void> = [];
  const mq: FakeMQ = {
    matches: initial,
    media:   '(prefers-color-scheme: dark)',
    onchange: null,
    _listeners: listeners,
    addEventListener: (_t, cb) => { listeners.push(cb); },
    removeEventListener: (_t, cb) => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    },
    addListener: (cb) => { listeners.push(cb); },
    removeListener: (cb) => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    },
    dispatchEvent: () => true,
    _fire: (matches: boolean) => {
      mq.matches = matches;
      const ev = { matches, media: mq.media } as MediaQueryListEvent;
      listeners.slice().forEach(cb => cb(ev));
    },
  };
  return mq;
}

let currentMQ: FakeMQ;

beforeEach(() => {
  localStorage.clear();
  currentMQ = makeMQ(false);
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable:     true,
    value:        () => currentMQ,
  });
});

afterEach(() => {
  cleanup();
});

interface Probe {
  current: ReturnType<typeof usePreferences> | null;
}

function Consumer({ probe }: { probe: Probe }) {
  probe.current = usePreferences();
  return null;
}

function mount(probe: Probe) {
  return render(
    <PreferencesProvider>
      <Consumer probe={probe} />
    </PreferencesProvider>,
  );
}

describe('PreferencesProvider / usePreferences', () => {
  test('mounts with defaults on empty storage', () => {
    const probe: Probe = { current: null };
    mount(probe);
    expect(probe.current?.darkMode).toBe(DEFAULT_PREFERENCES.darkMode);
    expect(probe.current?.rotateAmount).toBe(DEFAULT_PREFERENCES.rotateAmount);
  });

  test('mounts with stored values when present', () => {
    const stored: Preferences = {
      version: 1, darkMode: 'light', rotateAmount: 90,
      hotkeys: { ...DEFAULT_HOTKEYS },
      discordPresenceEnabled: true,
      showFps: false,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    const probe: Probe = { current: null };
    mount(probe);
    expect(probe.current?.darkMode).toBe('light');
    expect(probe.current?.rotateAmount).toBe(90);
  });

  test('exposes hotkeys from storage (read-only)', () => {
    const probe: Probe = { current: null };
    mount(probe);
    expect(probe.current?.hotkeys).toEqual(DEFAULT_HOTKEYS);
  });

  test('hotkeys are populated from stored blob on mount', () => {
    const custom = { ...DEFAULT_HOTKEYS, flip: 'g' };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1, darkMode: 'light', rotateAmount: 90, hotkeys: custom,
    }));
    const probe: Probe = { current: null };
    mount(probe);
    expect(probe.current?.hotkeys.flip).toBe('g');
  });

  test('setDarkMode mutates state and persists', () => {
    const probe: Probe = { current: null };
    mount(probe);
    act(() => { probe.current!.setDarkMode('dark'); });
    expect(probe.current?.darkMode).toBe('dark');
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toMatchObject({ version: 1, darkMode: 'dark' });
  });

  test('setRotateAmount mutates state and persists', () => {
    const probe: Probe = { current: null };
    mount(probe);
    act(() => { probe.current!.setRotateAmount(90); });
    expect(probe.current?.rotateAmount).toBe(90);
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toMatchObject({ version: 1, rotateAmount: 90 });
  });

  test('reset() reverts rotateAmount along with darkMode', () => {
    const probe: Probe = { current: null };
    mount(probe);
    act(() => { probe.current!.setDarkMode('dark'); });
    act(() => { probe.current!.setRotateAmount(180); });
    expect(probe.current?.darkMode).toBe('dark');
    expect(probe.current?.rotateAmount).toBe(180);
    act(() => { probe.current!.reset(); });
    expect(probe.current?.darkMode).toBe(DEFAULT_PREFERENCES.darkMode);
    expect(probe.current?.rotateAmount).toBe(DEFAULT_PREFERENCES.rotateAmount);
  });

  test('reset() restores both fields to defaults and writes', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1, darkMode: 'dark', rotateAmount: 180,
    }));
    const probe: Probe = { current: null };
    mount(probe);
    expect(probe.current?.darkMode).toBe('dark');
    act(() => { probe.current!.reset(); });
    expect(probe.current?.darkMode).toBe(DEFAULT_PREFERENCES.darkMode);
    expect(probe.current?.rotateAmount).toBe(DEFAULT_PREFERENCES.rotateAmount);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(DEFAULT_PREFERENCES);
  });

  test('resolvedTheme follows media-query when darkMode === "system"', () => {
    currentMQ = makeMQ(false); // light at boot
    const probe: Probe = { current: null };
    mount(probe);
    expect(probe.current?.darkMode).toBe('system');
    expect(probe.current?.resolvedTheme).toBe('light');
    act(() => { currentMQ._fire(true); });
    expect(probe.current?.resolvedTheme).toBe('dark');
    act(() => { currentMQ._fire(false); });
    expect(probe.current?.resolvedTheme).toBe('light');
  });

  test('resolvedTheme equals raw value when darkMode === "light" | "dark"', () => {
    currentMQ = makeMQ(true); // OS in dark
    const probe: Probe = { current: null };
    mount(probe);
    act(() => { probe.current!.setDarkMode('light'); });
    expect(probe.current?.resolvedTheme).toBe('light');
    act(() => { probe.current!.setDarkMode('dark'); });
    expect(probe.current?.resolvedTheme).toBe('dark');
  });
});

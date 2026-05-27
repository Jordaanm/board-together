import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { load, save } from './storage';
import { DEFAULT_HOTKEYS, DEFAULT_PREFERENCES, type ActionName, type DarkMode, type GridAlignment, type HotkeyMap, type Preferences, type RotateAmount } from './types';

export interface PreferencesContextValue {
  darkMode:               DarkMode;
  rotateAmount:           RotateAmount;
  hotkeys:                HotkeyMap;
  resolvedTheme:          'light' | 'dark';
  discordPresenceEnabled: boolean;
  showFps:                boolean;
  gridAlignment:          GridAlignment;
  setDarkMode:            (mode: DarkMode) => void;
  setRotateAmount:        (amount: RotateAmount) => void;
  // `key` is a lower-case single char, or `''` to unbind. Any conflicting
  // binding on a different action is cleared (no swap).
  setHotkey:              (action: ActionName, key: string) => void;
  setDiscordPresenceEnabled: (on: boolean) => void;
  setShowFps:             (on: boolean) => void;
  setGridAlignment:       (alignment: GridAlignment) => void;
  reset:                  () => void;
}

export const PreferencesContext = createContext<PreferencesContextValue | null>(null);

function readSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function deriveResolvedTheme(darkMode: DarkMode, systemTheme: 'light' | 'dark'): 'light' | 'dark' {
  if (darkMode === 'system') return systemTheme;
  return darkMode;
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Preferences>(() => load());
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(() => readSystemTheme());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemTheme(e.matches ? 'dark' : 'light');
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
    // Fallback for older Safari
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, []);

  const setDarkMode = useCallback((darkMode: DarkMode) => {
    setPrefs(prev => {
      const next = { ...prev, darkMode };
      save(next);
      return next;
    });
  }, []);

  const setRotateAmount = useCallback((rotateAmount: RotateAmount) => {
    setPrefs(prev => {
      const next = { ...prev, rotateAmount };
      save(next);
      return next;
    });
  }, []);

  const setHotkey = useCallback((action: ActionName, key: string) => {
    const normalised = key === '' ? '' : key.toLowerCase();
    if (normalised !== '' && normalised.length !== 1) return;
    setPrefs(prev => {
      const hotkeys: HotkeyMap = { ...prev.hotkeys };
      if (normalised !== '') {
        for (const name of Object.keys(hotkeys) as ActionName[]) {
          if (name !== action && hotkeys[name] === normalised) hotkeys[name] = '';
        }
      }
      hotkeys[action] = normalised;
      const next = { ...prev, hotkeys };
      save(next);
      return next;
    });
  }, []);

  const setDiscordPresenceEnabled = useCallback((on: boolean) => {
    setPrefs(prev => {
      const next = { ...prev, discordPresenceEnabled: on };
      save(next);
      return next;
    });
  }, []);

  const setShowFps = useCallback((on: boolean) => {
    setPrefs(prev => {
      const next = { ...prev, showFps: on };
      save(next);
      return next;
    });
  }, []);

  const setGridAlignment = useCallback((gridAlignment: GridAlignment) => {
    setPrefs(prev => {
      const next = { ...prev, gridAlignment };
      save(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    const next: Preferences = { ...DEFAULT_PREFERENCES, hotkeys: { ...DEFAULT_HOTKEYS } };
    save(next);
    setPrefs(next);
  }, []);

  const value = useMemo<PreferencesContextValue>(() => ({
    darkMode:               prefs.darkMode,
    rotateAmount:           prefs.rotateAmount,
    hotkeys:                prefs.hotkeys,
    resolvedTheme:          deriveResolvedTheme(prefs.darkMode, systemTheme),
    discordPresenceEnabled: prefs.discordPresenceEnabled,
    showFps:                prefs.showFps,
    gridAlignment:          prefs.gridAlignment,
    setDarkMode,
    setRotateAmount,
    setHotkey,
    setDiscordPresenceEnabled,
    setShowFps,
    setGridAlignment,
    reset,
  }), [prefs.darkMode, prefs.rotateAmount, prefs.hotkeys, prefs.discordPresenceEnabled, prefs.showFps, prefs.gridAlignment, systemTheme, setDarkMode, setRotateAmount, setHotkey, setDiscordPresenceEnabled, setShowFps, setGridAlignment, reset]);

  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}

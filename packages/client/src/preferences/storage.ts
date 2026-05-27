import {
  ACTION_NAMES,
  DARK_MODE_VALUES,
  DEFAULT_HOTKEYS,
  DEFAULT_PREFERENCES,
  GRID_ALIGNMENT_VALUES,
  ROTATE_AMOUNT_VALUES,
  type ActionName,
  type DarkMode,
  type GridAlignment,
  type HotkeyMap,
  type Preferences,
  type RotateAmount,
} from './types';

export const STORAGE_KEY = 'vt:prefs';

function readRaw(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    console.warn('[prefs] localStorage.getItem threw', err);
    return null;
  }
}

function isDarkMode(v: unknown): v is DarkMode {
  return typeof v === 'string' && (DARK_MODE_VALUES as readonly string[]).includes(v);
}

function isRotateAmount(v: unknown): v is RotateAmount {
  return typeof v === 'number' && (ROTATE_AMOUNT_VALUES as readonly number[]).includes(v);
}

function isGridAlignment(v: unknown): v is GridAlignment {
  return typeof v === 'string' && (GRID_ALIGNMENT_VALUES as readonly string[]).includes(v);
}

// Per-key sanitiser. Accepts an empty string ("unbound") or a single
// printable character; falls back to the default binding for anything else.
function sanitiseHotkeys(v: unknown): HotkeyMap {
  const out: HotkeyMap = { ...DEFAULT_HOTKEYS };
  if (v === null || typeof v !== 'object') return out;
  const obj = v as Record<string, unknown>;
  for (const name of ACTION_NAMES) {
    const raw = obj[name];
    if (typeof raw !== 'string') continue;       // missing → keep default
    if (raw === '' || raw.length === 1) {
      out[name as ActionName] = raw.toLowerCase();
    }
    // Otherwise leave the default in place.
  }
  return out;
}

export function load(): Preferences {
  const raw = readRaw();
  if (raw === null) return { ...DEFAULT_PREFERENCES, hotkeys: { ...DEFAULT_HOTKEYS } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[prefs] corrupt JSON in localStorage; using defaults');
    return { ...DEFAULT_PREFERENCES, hotkeys: { ...DEFAULT_HOTKEYS } };
  }

  if (parsed === null || typeof parsed !== 'object') {
    console.warn('[prefs] stored value is not an object; using defaults');
    return { ...DEFAULT_PREFERENCES, hotkeys: { ...DEFAULT_HOTKEYS } };
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) {
    console.warn('[prefs] unknown version; using defaults', obj.version);
    return { ...DEFAULT_PREFERENCES, hotkeys: { ...DEFAULT_HOTKEYS } };
  }

  return {
    version:                1,
    darkMode:               isDarkMode(obj.darkMode)         ? obj.darkMode     : DEFAULT_PREFERENCES.darkMode,
    rotateAmount:           isRotateAmount(obj.rotateAmount) ? obj.rotateAmount : DEFAULT_PREFERENCES.rotateAmount,
    hotkeys:                sanitiseHotkeys(obj.hotkeys),
    discordPresenceEnabled: typeof obj.discordPresenceEnabled === 'boolean'
      ? obj.discordPresenceEnabled
      : DEFAULT_PREFERENCES.discordPresenceEnabled,
    showFps: typeof obj.showFps === 'boolean'
      ? obj.showFps
      : DEFAULT_PREFERENCES.showFps,
    gridAlignment: isGridAlignment(obj.gridAlignment)
      ? obj.gridAlignment
      : DEFAULT_PREFERENCES.gridAlignment,
  };
}

export function save(prefs: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch (err) {
    console.warn('[prefs] localStorage.setItem threw', err);
  }
}

export type DarkMode = 'system' | 'light' | 'dark';
export type RotateAmount = 15 | 30 | 45 | 90 | 180;

// Canonical action vocabulary that may be hotkey-bound. Issue #2 of
// issues--hotkeys.md. Components register actions against these names; the
// HotkeyDispatcher (issue #3) resolves keys → names via `Preferences.hotkeys`.
export type ActionName =
  | 'flip'
  | 'rotate-cw'
  | 'rotate-ccw'
  | 'lock-toggle'
  | 'roll';

export const ACTION_NAMES: readonly ActionName[] = [
  'flip', 'rotate-cw', 'rotate-ccw', 'lock-toggle', 'roll',
];

export const ACTION_LABELS: Record<ActionName, string> = {
  'flip':        'Flip',
  'rotate-cw':   'Rotate CW',
  'rotate-ccw':  'Rotate CCW',
  'lock-toggle': 'Toggle Lock',
  'roll':        'Roll',
};

export type HotkeyMap = Record<ActionName, string>;

export interface Preferences {
  version:      1;
  darkMode:     DarkMode;
  rotateAmount: RotateAmount;
  // Single-character key bindings (lower-case). `roll` has no default binding
  // — empty string means "unbound" so the HotkeyDispatcher skips it.
  hotkeys:      HotkeyMap;
  // Whether to publish "Playing Board Together" Rich Presence via the local
  // Discord client while in a room. No-op when not signed in or the Discord
  // desktop client isn't running on this machine.
  discordPresenceEnabled: boolean;
  showFps: boolean;
}

export const DARK_MODE_VALUES: readonly DarkMode[] = ['system', 'light', 'dark'];
export const ROTATE_AMOUNT_VALUES: readonly RotateAmount[] = [15, 30, 45, 90, 180];

export const DEFAULT_HOTKEYS: HotkeyMap = {
  'flip':        'f',
  'rotate-cw':   'e',
  'rotate-ccw':  'q',
  'lock-toggle': 'l',
  'roll':        '',
};

export const DEFAULT_PREFERENCES: Preferences = {
  version:                1,
  darkMode:               'system',
  rotateAmount:           45,
  hotkeys:                { ...DEFAULT_HOTKEYS },
  discordPresenceEnabled: true,
  showFps:                false,
};

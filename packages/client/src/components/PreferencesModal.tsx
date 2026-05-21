import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { usePreferences } from '../preferences/usePreferences';
import { ACTION_LABELS, ACTION_NAMES, ROTATE_AMOUNT_VALUES, type ActionName, type DarkMode, type RotateAmount } from '../preferences/types';
import { useDiscordAuth } from '../discord/DiscordAuthProvider';
import { useAnchorTarget } from './AnchorLayout';

interface Props {
  open:         boolean;
  onOpenChange: (open: boolean) => void;
}

const OVERLAY: React.CSSProperties = {
  position:   'fixed',
  inset:      0,
  background: 'rgba(0,0,0,0.45)',
  zIndex:     200,
};

const CONTENT: React.CSSProperties = {
  width:         420,
  background:    'var(--surface)',
  border:        '1px solid var(--line)',
  borderRadius:  'var(--panel-radius)',
  color:         'var(--ink)',
  fontFamily:    'var(--font-sans)',
  fontSize:      13,
  zIndex:        201,
  display:       'flex',
  flexDirection: 'column',
  boxShadow:     'var(--shadow-lg)',
};

const HEADER: React.CSSProperties = {
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'space-between',
  padding:        '12px 16px',
  borderBottom:   '1px solid var(--line)',
  background:     'var(--surface-2)',
};

const TITLE: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontSize:   17,
  fontWeight: 600,
  letterSpacing: '-0.01em',
  margin:     0,
  color:      'var(--ink)',
};

const CLOSE_BTN: React.CSSProperties = {
  background: 'none',
  border:     'none',
  color:      'var(--ink-mute)',
  cursor:     'pointer',
  fontSize:   20,
  lineHeight: 1,
  padding:    '0 4px',
};

const BODY: React.CSSProperties = {
  padding: '16px',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

const FIELD_LABEL: React.CSSProperties = {
  fontSize:      11,
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
  color:         'var(--ink-mute)',
  fontWeight:    700,
  marginBottom:  6,
};

const SEG_GROUP: React.CSSProperties = {
  display:      'flex',
  background:   'var(--bg)',
  border:       '1px solid var(--line)',
  borderRadius: 'var(--card-radius)',
  padding:      2,
  gap:          2,
};

function segButton(active: boolean): React.CSSProperties {
  return {
    flex:         1,
    background:   active ? 'var(--accent)' : 'transparent',
    color:        active ? 'var(--accent-ink)' : 'var(--ink-mute)',
    border:       'none',
    borderRadius: 3,
    padding:      '8px 10px',
    cursor:       'pointer',
    fontSize:     13,
    fontFamily:   'inherit',
    fontWeight:   active ? 700 : 600,
    transition:   'background 160ms, color 160ms',
  };
}

const FOOTER: React.CSSProperties = {
  display:        'flex',
  justifyContent: 'flex-end',
  padding:        '10px 16px',
  borderTop:      '1px solid var(--line)',
  background:     'var(--surface-2)',
};

const RESET_BTN: React.CSSProperties = {
  background:   'transparent',
  border:       '1px solid var(--line-strong)',
  color:        'var(--ink)',
  padding:      '6px 14px',
  borderRadius: 'var(--card-radius)',
  cursor:       'pointer',
  fontFamily:   'inherit',
  fontSize:     13,
  fontWeight:   700,
};

const DARK_MODE_OPTIONS: { value: DarkMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light',  label: 'Light' },
  { value: 'dark',   label: 'Dark' },
];

const CHIP_ROW: React.CSSProperties = {
  display: 'flex',
  gap:     6,
  flexWrap: 'wrap',
};

function chipStyle(active: boolean): React.CSSProperties {
  return {
    background:   active ? 'var(--accent)' : 'var(--bg)',
    color:        active ? 'var(--accent-ink)' : 'var(--ink-2)',
    border:       active ? '1px solid var(--accent-deep)' : '1px solid var(--line)',
    padding:      '6px 12px',
    borderRadius: 999,
    cursor:       'pointer',
    fontSize:     13,
    fontFamily:   'inherit',
    fontWeight:   active ? 700 : 600,
    minWidth:     52,
    transition:   'background 160ms, color 160ms, border-color 160ms',
  };
}

const TOGGLE_ROW: React.CSSProperties = {
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'space-between',
  width:          '100%',
  background:     'var(--bg)',
  border:         '1px solid var(--line)',
  borderRadius:   'var(--card-radius)',
  color:          'var(--ink)',
  padding:        '8px 10px',
  cursor:         'pointer',
  fontFamily:     'inherit',
  fontSize:       13,
};

const SECTION_TOGGLE: React.CSSProperties = {
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'space-between',
  width:          '100%',
  background:     'var(--bg)',
  border:         '1px solid var(--line)',
  borderRadius:   'var(--card-radius)',
  color:          'var(--ink-mute)',
  padding:        '8px 10px',
  cursor:         'pointer',
  fontFamily:     'inherit',
  fontSize:       11,
  fontWeight:     700,
  textTransform:  'uppercase',
  letterSpacing:  '0.14em',
};

const HOTKEY_LIST: React.CSSProperties = {
  display:       'flex',
  flexDirection: 'column',
  gap:           6,
  marginTop:     8,
};

const HOTKEY_ROW: React.CSSProperties = {
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'space-between',
  padding:        '6px 4px',
  gap:            8,
};

const HOTKEY_LABEL: React.CSSProperties = {
  color:    'var(--ink)',
  fontSize: 13,
  fontWeight: 600,
};

function bindingButton(active: boolean): React.CSSProperties {
  return {
    minWidth:     90,
    background:   active ? 'var(--accent)' : 'var(--bg)',
    color:        active ? 'var(--accent-ink)' : 'var(--ink)',
    border:       active ? '1px solid var(--accent-deep)' : '1px solid var(--line)',
    borderRadius: 'var(--card-radius)',
    padding:      '6px 12px',
    cursor:       'pointer',
    fontFamily:   'var(--font-mono)',
    fontSize:     13,
    fontWeight:   700,
    textAlign:    'center',
    transition:   'background 160ms, color 160ms',
  };
}

function formatKey(key: string): string {
  if (key === '') return 'Unbound';
  if (key === ' ') return 'Space';
  return key.toUpperCase();
}

export function PreferencesModal({ open, onOpenChange }: Props) {
  const centerAnchor = useAnchorTarget('center');
  const {
    darkMode, setDarkMode, rotateAmount, setRotateAmount, hotkeys, setHotkey, reset,
    discordPresenceEnabled, setDiscordPresenceEnabled,
    showFps, setShowFps,
  } = usePreferences();
  const { isSignedIn } = useDiscordAuth();
  const [hotkeysOpen, setHotkeysOpen] = useState(false);
  const [capturing, setCapturing] = useState<ActionName | null>(null);

  useEffect(() => {
    if (!open) setCapturing(null);
  }, [open]);

  useEffect(() => {
    if (capturing === null) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setCapturing(null); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        setHotkey(capturing, '');
        setCapturing(null);
        return;
      }
      if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key.length !== 1) return;
      setHotkey(capturing, e.key.toLowerCase());
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, setHotkey]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={centerAnchor ?? undefined}>
        <Dialog.Overlay style={OVERLAY} />
        <Dialog.Content style={CONTENT} aria-describedby={undefined}>
          <div style={HEADER}>
            <Dialog.Title style={TITLE}>Preferences</Dialog.Title>
            <Dialog.Close asChild>
              <button style={CLOSE_BTN} type="button" aria-label="Close">×</button>
            </Dialog.Close>
          </div>

          <div style={BODY}>
            <div>
              <div style={FIELD_LABEL}>Theme</div>
              <div style={SEG_GROUP} role="radiogroup" aria-label="Theme">
                {DARK_MODE_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={darkMode === opt.value}
                    style={segButton(darkMode === opt.value)}
                    onClick={() => setDarkMode(opt.value)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div style={FIELD_LABEL}>Rotate Amount</div>
              <div style={CHIP_ROW} role="radiogroup" aria-label="Rotate Amount">
                {ROTATE_AMOUNT_VALUES.map((value: RotateAmount) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={rotateAmount === value}
                    style={chipStyle(rotateAmount === value)}
                    onClick={() => setRotateAmount(value)}
                  >
                    {value}°
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div style={FIELD_LABEL}>Display</div>
              <label style={TOGGLE_ROW}>
                <span>Show FPS counter</span>
                <input
                  type="checkbox"
                  checked={showFps}
                  onChange={(e) => setShowFps(e.target.checked)}
                />
              </label>
            </div>

            {isSignedIn && (
              <div>
                <div style={FIELD_LABEL}>Discord</div>
                <label style={TOGGLE_ROW}>
                  <span>Show on Discord profile</span>
                  <input
                    type="checkbox"
                    checked={discordPresenceEnabled}
                    onChange={(e) => setDiscordPresenceEnabled(e.target.checked)}
                  />
                </label>
              </div>
            )}

            <div>
              <button
                type="button"
                style={SECTION_TOGGLE}
                aria-expanded={hotkeysOpen}
                onClick={() => setHotkeysOpen(o => !o)}
              >
                <span>Hotkeys</span>
                <span aria-hidden="true">{hotkeysOpen ? '▾' : '▸'}</span>
              </button>
              {hotkeysOpen && (
                <div style={HOTKEY_LIST}>
                  {ACTION_NAMES.map(action => {
                    const active = capturing === action;
                    return (
                      <div key={action} style={HOTKEY_ROW}>
                        <span style={HOTKEY_LABEL}>{ACTION_LABELS[action]}</span>
                        <button
                          type="button"
                          style={bindingButton(active)}
                          onClick={() => setCapturing(active ? null : action)}
                          title="Click, then press a key. Esc cancels, Backspace unbinds."
                        >
                          {active ? 'Press a key…' : formatKey(hotkeys[action])}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div style={FOOTER}>
            <button style={RESET_BTN} type="button" onClick={reset}>Reset</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

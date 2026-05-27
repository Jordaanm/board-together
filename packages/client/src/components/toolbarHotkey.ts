// Pure hotkey-resolution helper for the Toolbar — issue 2b of issues--tools.md.
//
// Factored out of Toolbar.tsx so the suppress-while-text-input-focused +
// suppress-on-repeat rules can be unit tested without a DOM.

interface KeyEventLike {
  key:      string;
  repeat:   boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

interface ToolSlot {
  readonly id: string;
}

// Returns the tool id to activate, or null if the event should be ignored.
// Ctrl+digit (or Cmd+digit on mac) 1..N maps to slot order; suppressed when a
// text input is focused or when the event is a key-repeat. Bare digits resolve
// to null so the layout hotkey can claim them.
export function resolveHotkey(
  e:                 KeyEventLike,
  catalogue:         readonly ToolSlot[],
  textInputFocused:  boolean,
): string | null {
  if (e.repeat) return null;
  if (textInputFocused) return null;
  if (!e.ctrlKey && !e.metaKey) return null;
  // Only single-digit number keys; '10' is two events (1 then 0), not '10'.
  if (e.key.length !== 1) return null;
  const idx = parseInt(e.key, 10);
  if (!Number.isFinite(idx) || idx < 1 || idx > catalogue.length) return null;
  return catalogue[idx - 1]?.id ?? null;
}

export function isTextInputFocused(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

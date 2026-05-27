// Toolbar — issue 2b of issues--tools.md.
//
// Vertical tool palette in the lower-left. Renders the static TOOL_CATALOGUE,
// indicates the active tool, and binds numeric hotkeys (1..N) to slot order.
// Hotkeys are suppressed when a text input has focus or when the event is a
// key-repeat. Tool switches respect the dispatcher's reject-during-gesture
// rule — the caller is given the dispatcher's accept/reject and only updates
// React state when accepted.

import { useEffect } from 'react';
import { TOOL_CATALOGUE } from '../input/tools';
import { resolveHotkey, isTextInputFocused } from './toolbarHotkey';
import './Toolbar.css';

interface Props {
  activeToolId: string;
  // Returns true if the dispatcher accepted the switch. The toolbar updates
  // React state inside this callback; rejection is silent.
  onSelectTool: (toolId: string) => void;
}

export function Toolbar({ activeToolId, onSelectTool }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const id = resolveHotkey(
        { key: e.key, repeat: e.repeat, ctrlKey: e.ctrlKey, metaKey: e.metaKey },
        TOOL_CATALOGUE,
        isTextInputFocused(),
      );
      if (id !== null) onSelectTool(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSelectTool]);

  return (
    <div className="toolbar" role="toolbar" aria-label="Tools">
      {TOOL_CATALOGUE.map((tool, i) => {
        const isActive = tool.id === activeToolId;
        const hotkey   = tool.hotkey ?? String(i + 1);
        return (
          <button
            key={tool.id}
            type="button"
            className={`toolbar__slot${isActive ? ' toolbar__slot--active' : ''}`}
            title={`${tool.label} (${hotkey})`}
            onClick={() => onSelectTool(tool.id)}
          >
            {tool.label}
            <span className="toolbar__hotkey">{hotkey}</span>
          </button>
        );
      })}
    </div>
  );
}

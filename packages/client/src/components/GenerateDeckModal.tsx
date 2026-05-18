// Host-only "Generate Deck" modal. Picks a spritesheet asset and a back-cell
// from its grid, then spawns one card per non-back cell with that cell as the
// face and the selected cell as the back. An optional tag is applied to every
// spawned card.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useAnchorTarget } from './AnchorLayout';
import { type ManifestStore } from '../assets/ManifestStore';
import { type AssetEntry } from '../assets/Manifest';
import { type BundleStore } from '../assets/BundleStore';
import { serializeSpriteRef } from '../assets/spriteRef';
import { useEntryImageSrc } from '../assets/useEntryImageSrc';

export interface GenerateDeckRequest {
  faceRefs: string[];
  backRef:  string;
  tag:      string;
}

interface Props {
  store:         ManifestStore | null;
  onGenerate:    (req: GenerateDeckRequest) => void;
  open?:         boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?:  boolean;
  // When the selected spritesheet is `bundled: true`, the grid cells need
  // a BundleStore lookup to mint an Object URL — `sheet.url` is the empty
  // breadcrumb at that point.
  bundleStore?:  BundleStore;
}

const TRIGGER_BTN: React.CSSProperties = {
  background:   'var(--surface)',
  border:       '1px solid var(--line-strong)',
  color:        'var(--ink)',
  padding:      '8px 12px',
  borderRadius: 'var(--panel-radius)',
  cursor:       'pointer',
  fontFamily:   'var(--font-sans)',
  fontSize:     12,
  boxShadow:    'var(--shadow-lg)',
  userSelect:   'none',
};

const OVERLAY: React.CSSProperties = {
  position:   'fixed',
  inset:      0,
  background: 'rgba(0,0,0,0.45)',
  zIndex:     200,
};

const CONTENT: React.CSSProperties = {
  width:         560,
  maxWidth:      '90vw',
  maxHeight:     '80vh',
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
};

const TITLE: React.CSSProperties = {
  fontSize:      14,
  fontWeight:    600,
  margin:        0,
  fontFamily:    'var(--font-serif)',
  letterSpacing: '-0.01em',
};

const CLOSE_BTN: React.CSSProperties = {
  background: 'none', border: 'none', color: 'var(--ink-mute)',
  cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 4px',
};

const BODY: React.CSSProperties = {
  flex:      1,
  overflowY: 'auto',
  padding:   '12px 16px',
};

const FIELD: React.CSSProperties = {
  display:       'flex',
  flexDirection: 'column',
  gap:           4,
  marginBottom:  12,
};

const LABEL: React.CSSProperties = {
  fontSize: 11,
  color:    'var(--ink-2)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

const INPUT: React.CSSProperties = {
  background:   'var(--bg)',
  border:       '1px solid var(--line-strong)',
  color:        'var(--ink)',
  padding:      '6px 8px',
  borderRadius: 3,
  fontSize:     12,
  fontFamily:   'inherit',
};

const HINT: React.CSSProperties = {
  fontSize: 11,
  color:    'var(--ink-mute)',
};

const FOOTER: React.CSSProperties = {
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'space-between',
  padding:        '10px 16px',
  borderTop:      '1px solid var(--line)',
  fontSize:       12,
};

const FOOTER_BTNS: React.CSSProperties = {
  display: 'flex',
  gap:     8,
};

const BTN: React.CSSProperties = {
  background:   'var(--surface-2)',
  border:       '1px solid var(--line-strong)',
  color:        'var(--ink)',
  padding:      '6px 12px',
  borderRadius: 'var(--card-radius)',
  cursor:       'pointer',
  fontSize:     12,
};

const BTN_PRIMARY: React.CSSProperties = {
  ...BTN,
  background:   'color-mix(in oklab, var(--accent) 22%, transparent)',
  borderColor:  'var(--accent)',
};

const BTN_DISABLED: React.CSSProperties = {
  ...BTN,
  opacity: 0.45,
  cursor:  'not-allowed',
};

const COUNT: React.CSSProperties = {
  color: 'var(--ink-2)',
};

export function GenerateDeckModal({
  store, onGenerate, open: controlledOpen, onOpenChange, hideTrigger, bundleStore,
}: Props) {
  const centerAnchor = useAnchorTarget('center');
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  return (
    <>
      {!hideTrigger && (
        <button type="button" style={TRIGGER_BTN} onClick={() => setOpen(true)} disabled={!store}>
          Generate Deck
        </button>
      )}
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal container={centerAnchor ?? undefined}>
          <Dialog.Overlay style={OVERLAY} />
          <Dialog.Content style={CONTENT} aria-describedby={undefined}>
            <div style={HEADER}>
              <Dialog.Title style={TITLE}>Generate Deck</Dialog.Title>
              <Dialog.Close asChild>
                <button style={CLOSE_BTN} type="button" aria-label="Close">×</button>
              </Dialog.Close>
            </div>
            {open && (
              <Body
                store={store}
                bundleStore={bundleStore}
                onGenerate={(req) => { onGenerate(req); setOpen(false); }}
                onCancel={() => setOpen(false)}
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function Body({
  store, bundleStore, onGenerate, onCancel,
}: {
  store:        ManifestStore | null;
  bundleStore?: BundleStore;
  onGenerate:   (req: GenerateDeckRequest) => void;
  onCancel:     () => void;
}) {
  const draft = useSyncExternalStore(
    (cb) => store?.subscribe(cb) ?? (() => {}),
    () => store?.getDraft() ?? null,
  );

  const sheets = useMemo(
    () => (draft?.list({ type: 'spritesheet' }) ?? []),
    [draft],
  );

  const [sheetSlug, setSheetSlug] = useState<string>('');
  const [backIndex, setBackIndex] = useState<number | null>(null);
  const [tag,       setTag]       = useState('');

  // Default to the first available sheet on mount / when the list changes.
  useEffect(() => {
    if (sheetSlug && sheets.some((s) => s.slug === sheetSlug)) return;
    setSheetSlug(sheets[0]?.slug ?? '');
    setBackIndex(null);
  }, [sheets, sheetSlug]);

  const sheet = useMemo(
    () => sheets.find((s) => s.slug === sheetSlug),
    [sheets, sheetSlug],
  );

  const total      = sheet ? (sheet.cols ?? 0) * (sheet.rows ?? 0) : 0;
  const faceCount  = backIndex === null ? 0 : Math.max(0, total - 1);
  const canSubmit  = sheet !== undefined && backIndex !== null && total > 1;

  const submit = () => {
    if (!sheet || backIndex === null) return;
    const faceRefs: string[] = [];
    for (let i = 0; i < total; i++) {
      if (i === backIndex) continue;
      faceRefs.push(serializeSpriteRef(sheet.slug, i));
    }
    onGenerate({
      faceRefs,
      backRef: serializeSpriteRef(sheet.slug, backIndex),
      tag:     tag.trim(),
    });
  };

  return (
    <>
      <div style={BODY}>
        {sheets.length === 0 ? (
          <div style={{ color: 'var(--ink-mute)', fontSize: 12, padding: 16 }}>
            No spritesheet assets yet. Add one in the Asset Manager first.
          </div>
        ) : (
          <>
            <div style={FIELD}>
              <span style={LABEL}>Spritesheet</span>
              <select
                style={INPUT}
                value={sheetSlug}
                onChange={(e) => { setSheetSlug(e.target.value); setBackIndex(null); }}
              >
                {sheets.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.name} ({s.cols}×{s.rows}) — {s.slug}
                  </option>
                ))}
              </select>
            </div>

            <div style={FIELD}>
              <span style={LABEL}>Back image</span>
              <span style={HINT}>
                Click a cell to mark it as the card back. Every other cell becomes a face.
              </span>
              {sheet && (
                <SheetGrid sheet={sheet} bundleStore={bundleStore} selectedIndex={backIndex} onPick={setBackIndex} />
              )}
            </div>

            <div style={FIELD}>
              <span style={LABEL}>Tag (optional)</span>
              <input
                style={INPUT}
                type="text"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                placeholder="e.g. tarot-deck"
              />
            </div>
          </>
        )}
      </div>
      <div style={FOOTER}>
        <span style={COUNT}>
          {canSubmit
            ? `${faceCount} card${faceCount === 1 ? '' : 's'} will spawn.`
            : sheet
              ? backIndex === null
                ? 'Pick a back image to continue.'
                : 'Sheet must have at least 2 cells.'
              : ''}
        </span>
        <div style={FOOTER_BTNS}>
          <button type="button" style={BTN} onClick={onCancel}>Cancel</button>
          <button
            type="button"
            style={canSubmit ? BTN_PRIMARY : BTN_DISABLED}
            disabled={!canSubmit}
            onClick={submit}
          >
            Generate
          </button>
        </div>
      </div>
    </>
  );
}

const SELECTED_BORDER = '2px solid var(--accent)';
const CELL_BORDER     = '1px solid var(--line)';

function SheetGrid({
  sheet, bundleStore, selectedIndex, onPick,
}: {
  sheet:         AssetEntry;
  bundleStore?:  BundleStore;
  selectedIndex: number | null;
  onPick:        (i: number) => void;
}) {
  const cols = sheet.cols ?? 1;
  const rows = sheet.rows ?? 1;
  const total = cols * rows;
  const cells: number[] = [];
  for (let i = 0; i < total; i++) cells.push(i);
  const sheetSrc = useEntryImageSrc(sheet, bundleStore);

  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: `repeat(${cols}, minmax(40px, 1fr))`,
      gap:                 4,
      marginTop:           4,
    }}>
      {cells.map((i) => {
        const col       = i % cols;
        const row       = Math.floor(i / cols);
        const bgPosX    = cols === 1 ? '50%' : `${(col / (cols - 1)) * 100}%`;
        const bgPosY    = rows === 1 ? '50%' : `${(row / (rows - 1)) * 100}%`;
        const isSelected = i === selectedIndex;
        return (
          <div
            key={i}
            onClick={() => onPick(i)}
            title={`${sheet.slug}:${i}`}
            style={{
              aspectRatio:        '1 / 1',
              backgroundImage:    sheetSrc ? `url("${sheetSrc}")` : undefined,
              backgroundColor:    sheetSrc ? undefined : 'var(--bg)',
              backgroundSize:     `${cols * 100}% ${rows * 100}%`,
              backgroundPosition: `${bgPosX} ${bgPosY}`,
              backgroundRepeat:   'no-repeat',
              border:             isSelected ? SELECTED_BORDER : CELL_BORDER,
              borderRadius:       3,
              cursor:             'pointer',
            }}
          />
        );
      })}
    </div>
  );
}

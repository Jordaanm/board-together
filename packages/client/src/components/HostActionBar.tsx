// Top-center action bar visible only to the host. Renders a single "Tools"
// dropdown grouping all host actions (spawn, save / load, scripting, asset
// manager, turn order, etc). Each leaf flips a controlled-open flag on the
// corresponding modal; modals themselves stay fully self-contained.

import { useRef, useState, type ReactNode } from 'react';
import { SpawnObjectModal } from './SpawnObjectModal';
import { LoadSceneModal } from './LoadSceneModal';
import { RevertConfirmModal } from './RevertConfirmModal';
import { HistoryModal } from './HistoryModal';
import { ScriptEditorModal } from './ScriptEditorModal';
import { ScriptConsoleModal } from './ScriptConsoleModal';
import { AssetManagerModal } from './AssetManagerModal';
import { type BundleStore } from '../assets/BundleStore';
import { type BundleCache } from '../assets/BundleCache';
import { GenerateDeckModal, type GenerateDeckRequest } from './GenerateDeckModal';
import { HostToolsMenu, type MenuEntry } from './HostToolsMenu';
import { RoomSettingsModal } from './RoomSettingsModal';
import { type PublicBanEntry } from '../net/ConnectionManager';
import { type SaveEnvelope, type SaveZipBundle } from '../entity/SaveFile';
import { downloadSceneFile } from '../entity/downloadSceneFile';
import { type LastLoaded, type SceneHistoryService } from '../entity/SceneHistoryService';
import { type ScriptErrorLog } from '../scripting/ScriptErrorLog';
import { type ManifestStore } from '../assets/ManifestStore';
import { type SceneHandle } from '../entity/world';
import { type TurnState } from '../seats/TurnTracker';

interface Props {
  handle:               SceneHandle;
  showAllZones:         boolean;
  onToggleShowAllZones: (on: boolean) => void;
  showSnapPoints:         boolean;
  onToggleShowSnapPoints: (on: boolean) => void;
  onLoad:               (envelope: SaveEnvelope, filename: string, bundles: SaveZipBundle[]) => void;
  onRevert:             () => void;
  lastLoaded:           LastLoaded | null;
  currentEntityCount:   number;
  historyService:       SceneHistoryService | null;
  scriptSource:         string;
  onScriptChange:       (next: string) => void;
  scriptErrorLog:       ScriptErrorLog | null;
  manifestStore:        ManifestStore | null;
  onPushManifest:       () => void;
  bundleStore?:         BundleStore;
  bundleCache?:         BundleCache;
  // Render-prop that supplies the turn-controls panel with controlled-open
  // wiring. HostActionBar owns the open flag so the panel toggles from the
  // Tools menu.
  turnControls?:        (controlled: { open: boolean; onOpenChange: (o: boolean) => void; hideTrigger: boolean }) => ReactNode;
  // Current turn-tracker state, embedded in the save envelope.
  turns?:               TurnState;
  // Room name shown in the settings modal and committed via onRenameRoom.
  roomName:             string;
  onRenameRoom:         (name: string) => void;
  // Password state for the settings modal. The current value is never sent
  // to the client; only `hasPassword` is exposed.
  hasPassword:          boolean;
  onSetRoomPassword:    (password: string | null) => void;
  // Current ban list for the Bans section.
  bans:                 PublicBanEntry[];
  onUnban:              (name: string) => void;
}

const BAR: React.CSSProperties = {
  display:    'flex',
  alignItems: 'center',
  gap:        8,
};

const FILE_LABEL: React.CSSProperties = {
  display:    'inline-flex',
  alignItems: 'center',
  gap:        4,
  marginLeft: 4,
  color:      'var(--ink-mute)',
  fontFamily: 'var(--font-sans)',
  fontSize:   11,
  userSelect: 'none',
};

const FILE_NAME: React.CSSProperties = {
  color:    'var(--ink)',
  fontWeight: 700,
};

const FILE_TIMESTAMP: React.CSSProperties = {
  color: 'var(--ink-mute)',
};

export function HostActionBar({
  handle,
  showAllZones,
  onToggleShowAllZones,
  showSnapPoints,
  onToggleShowSnapPoints,
  onLoad,
  onRevert,
  lastLoaded,
  currentEntityCount,
  historyService,
  scriptSource,
  onScriptChange,
  scriptErrorLog,
  manifestStore,
  onPushManifest,
  bundleStore,
  bundleCache,
  turnControls,
  turns,
  roomName,
  onRenameRoom,
  hasPassword,
  onSetRoomPassword,
  bans,
  onUnban,
}: Props) {
  const [spawnOpen,    setSpawnOpen]    = useState(false);
  const [historyOpen,  setHistoryOpen]  = useState(false);
  const [scriptOpen,   setScriptOpen]   = useState(false);
  const [consoleOpen,  setConsoleOpen]  = useState(false);
  const [assetsOpen,   setAssetsOpen]   = useState(false);
  const [deckOpen,     setDeckOpen]     = useState(false);
  const [revertOpen,   setRevertOpen]   = useState(false);
  const [turnsOpen,    setTurnsOpen]    = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const loadTriggerRef = useRef<{ open: () => void } | null>(null);

  const canRevert = lastLoaded !== null;
  const scriptingAvailable = handle.controller.scripting !== null;

  const handleGenerateDeck = (req: GenerateDeckRequest) => {
    handle.controller.generateDeck({
      faceRefs: req.faceRefs,
      backRef:  req.backRef,
      category: req.tag,
      tag:      req.tag,
    });
  };

  const handleSave = () => {
    const thumbnail = handle.captureThumbnail();
    void downloadSceneFile(
      handle.controller.snapshot(),
      thumbnail,
      manifestStore?.getDraft().toArray() ?? [],
      handle.controller.scripting?.getScriptState(),
      turns,
      bundleStore,
    );
  };

  const entries: MenuEntry[] = [
    { label: 'Room Settings', onClick: () => setSettingsOpen(true) },
    { label: 'Spawn', onClick: () => setSpawnOpen(true) },
    {
      label: 'Game State',
      items: [
        { label: 'Save',    onClick: handleSave },
        { label: 'Load',    onClick: () => loadTriggerRef.current?.open() },
        { label: 'Revert',  onClick: () => setRevertOpen(true), disabled: !canRevert },
        { label: 'History', onClick: () => setHistoryOpen(true) },
      ],
    },
    {
      label: 'Assets',
      items: [
        { label: 'Asset Manager',  onClick: () => setAssetsOpen(true), disabled: !manifestStore },
        { label: 'Generate Deck',  onClick: () => setDeckOpen(true),   disabled: !manifestStore },
      ],
    },
    {
      label: 'Code',
      items: [
        { label: 'Script',  onClick: () => setScriptOpen(true) },
        { label: 'Console', onClick: () => setConsoleOpen(true), disabled: !scriptingAvailable },
      ],
    },
    {
      label: 'Other',
      items: [
        ...(turnControls ? [{ label: 'Turn Order', onClick: () => setTurnsOpen(true) }] : []),
        {
          label:   'Show all zones',
          onClick: () => onToggleShowAllZones(!showAllZones),
          checked: showAllZones,
        },
        {
          label:   'Show Snap Points',
          onClick: () => onToggleShowSnapPoints(!showSnapPoints),
          checked: showSnapPoints,
        },
      ],
    },
  ];

  return (
    <div style={BAR}>
      <HostToolsMenu label="Tools" entries={entries} />

      <SpawnObjectModal
        onSpawn={(type) => { handle.controller.spawn(type); }}
        open={spawnOpen}
        onOpenChange={setSpawnOpen}
        hideTrigger
      />
      <LoadSceneModal
        currentEntityCount={currentEntityCount}
        onConfirmLoad={onLoad}
        triggerRef={loadTriggerRef}
        hideTrigger
      />
      <HistoryModal
        service={historyService}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        hideTrigger
      />
      <ScriptEditorModal
        source={scriptSource}
        onChange={onScriptChange}
        onSave={() => handle.controller.scripting?.setSource(scriptSource)}
        onRun={(src) => {
          const sh = handle.controller.scripting;
          if (!sh) return Promise.resolve({ ok: false, error: 'Scripting unavailable.' });
          return sh.runScript(src);
        }}
        getSavedSource={() => handle.controller.scripting?.getScriptState().source ?? ''}
        errorLog={scriptErrorLog}
        open={scriptOpen}
        onOpenChange={setScriptOpen}
        hideTrigger
      />
      <AssetManagerModal
        store={manifestStore}
        onPush={onPushManifest}
        open={assetsOpen}
        onOpenChange={setAssetsOpen}
        hideTrigger
        bundleStore={bundleStore}
        bundleCache={bundleCache}
      />
      <GenerateDeckModal
        store={manifestStore}
        onGenerate={handleGenerateDeck}
        open={deckOpen}
        onOpenChange={setDeckOpen}
        hideTrigger
      />
      <ScriptConsoleModal
        onRun={
          handle.controller.scripting
            ? (src) => handle.controller.scripting!.runOneShot(src)
            : null
        }
        open={consoleOpen}
        onOpenChange={setConsoleOpen}
        hideTrigger
      />
      {turnControls?.({ open: turnsOpen, onOpenChange: setTurnsOpen, hideTrigger: true })}

      <RoomSettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        roomName={roomName}
        onRenameRoom={onRenameRoom}
        hasPassword={hasPassword}
        onSetRoomPassword={onSetRoomPassword}
        bans={bans}
        onUnban={onUnban}
      />

      {lastLoaded && (
        <span style={FILE_LABEL}>
          <span style={FILE_NAME}>{lastLoaded.filename}</span>
          <span style={FILE_TIMESTAMP}>{formatLoadedAt(lastLoaded.savedAt)}</span>
        </span>
      )}
      <RevertConfirmModal
        open={revertOpen}
        filename={lastLoaded?.filename ?? ''}
        onCancel={() => setRevertOpen(false)}
        onConfirm={() => { setRevertOpen(false); onRevert(); }}
      />
    </div>
  );
}

function formatLoadedAt(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

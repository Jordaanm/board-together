import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ThreeCanvas, type ReplicationTarget, type HandView } from '../ThreeCanvas';
import { ConnectionManager } from '../net/ConnectionManager';
import { EditorPanel } from '../components/EditorPanel';
import { useSceneObjects } from '../components/useSceneObjects';
import { ContextMenu } from '../components/ContextMenu';
import { PlayersPanel } from '../components/PlayersPanel';
import { EndTurnButton } from '../components/EndTurnButton';
import { TurnControlsPanel } from '../components/TurnControlsPanel';
import { Toolbar } from '../components/Toolbar';
import { HostActionBar } from '../components/HostActionBar';
import { AnchorLayout } from '../components/AnchorLayout';
import { UIPanel } from '../components/UIPanel';
import { HandPanel } from '../components/HandPanel';
import { InspectDeckDialog } from '../components/InspectDeckDialog';
import { PreferencesTrigger } from '../components/PreferencesTrigger';
import { FpsCounter } from '../components/FpsCounter';
import { load as loadPreferences } from '../preferences/storage';
import { loadDisplayName } from '../identity/displayName';
import { useDiscordAuth } from '../discord/DiscordAuthProvider';
import { RichPresenceController } from '../discord/RichPresenceController';
import { SEAT_COUNT } from '../seats/RoomStateManager';
import { usePreferences } from '../preferences/usePreferences';
import { TOOL_CATALOGUE } from '../input/tools';
import { type ContextMenuRequest, dispatchAction, dispatchMenuAction } from '../input/ContextMenuController';
import { type MenuItem } from '../entity/EntityComponent';
import { aggregateContextMenu } from '../entity/contextMenu';
import { aggregateEditorTools, dispatchEditorTool, type EditorToolItem } from '../entity/editorTools';
import { applySelectionClick, applySelectionMarquee, SelectionStore, type SelectionClickModifier } from '../input/SelectionStore';
import { resolveLayoutHotkey, performSelectionLayout } from '../input/selectionLayoutHotkey';
import { isTextInputFocused } from '../components/toolbarHotkey';
import { type ChannelMessage } from '../net/SceneState';
import { type SeatIndex } from '../seats/SeatLayout';
import { TABLE_ENTITY_ID } from '../entity/tableEntity';
import { TableComponent } from '../entity/components/TableComponent';
import { seatPoseFromState } from '../seats/SeatPoseState';
import { computeOrbitForSeat } from '../seats/computeOrbitForSeat';
import { DiceComponent } from '../entity/components/DiceComponent';
import { DeckComponent } from '../entity/components/DeckComponent';
import { RoomStateManager } from '../seats/RoomStateManager';
import { RoomStateClient } from '../seats/RoomStateClient';
import type { RoomStateMessage, RoomStateSnapshot } from '../seats/RoomState';
import type { PublicBanEntry } from '../net/ConnectionManager';
import type { TurnAction, TurnEvent } from '../seats/TurnTracker';
import { type SceneHistoryService, type LastLoaded } from '../entity/SceneHistoryService';
import { type ScriptErrorLog } from '../scripting/ScriptErrorLog';
import { type SceneHandle } from '../entity/world';
import { ManifestStore } from '../assets/ManifestStore';
import { assetService } from '../assets/AssetService';
import { BundleStore } from '../assets/BundleStore';
import { BundleCache } from '../assets/BundleCache';
import { IdbBundleCacheDriver } from '../assets/IdbBundleCacheDriver';
import { BASE_MANIFEST, PRIMITIVE_MANIFEST } from '../assets/baseManifest';
import { AssetLoadingIndicator } from '../components/AssetLoadingIndicator';
import { PdfOverlayController } from '../components/PdfOverlayController';
import { PdfOverlaySheet } from '../components/PdfOverlaySheet';
import './Room.css';

type Status = 'connecting' | 'connected' | 'disconnected' | 'room-full' | 'wrong-password' | 'banned';

const SIGNALING_URL = import.meta.env.VITE_API_URL.replace(/^http/, 'ws');

const STATUS_LABEL: Record<Status, string> = {
  connecting:       'Waiting for peer...',
  connected:        'Connected',
  disconnected:     'Disconnected',
  'room-full':      'Room is full',
  'wrong-password': 'Wrong password',
  banned:           'You are banned from this room',
};

interface Props {
  roomId: string;
  isHost: boolean;
}

const noop = () => {};

export function Room({ roomId, isHost }: Props) {
  const [status,       setStatus]       = useState<Status>('connecting');
  const [contextMenu,  setContextMenu]  = useState<ContextMenuRequest | null>(null);
  // SelectionStore is the canonical multi-id state; React mirror lives in
  // `selectedIds`. Single-id consumers (panels, gizmo wiring) derive the
  // solo id from size === 1.
  const selectionStore = useMemo(() => new SelectionStore(), []);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => selectionStore.subscribe(() => {
    setSelectedIds(new Set(selectionStore.ids()));
  }), [selectionStore]);
  const selectedId: string | null = selectedIds.size === 1
    ? selectedIds.values().next().value ?? null
    : null;
  const setSelectedId = (id: string | null) => {
    if (id === null) selectionStore.clear();
    else selectionStore.replace(id);
  };
  const [isFreeCamera, setIsFreeCamera] = useState(false);
  const [roomSnapshot, setRoomSnapshot] = useState<RoomStateSnapshot | null>(null);
  const [selfPeerId,   setSelfPeerId]   = useState<string | null>(null);
  const [activeToolId, setActiveToolId] = useState<string>(TOOL_CATALOGUE[0]?.id ?? 'grab');
  const [showAllZones, setShowAllZones] = useState(false);
  const [showSnapPoints, setShowSnapPoints] = useState(false);
  const [showHitboxes, setShowHitboxes] = useState(false);
  const [roomName,     setRoomName]     = useState<string>('');
  const [hasPassword,  setHasPassword]  = useState<boolean>(false);
  const [bans,         setBans]         = useState<PublicBanEntry[]>([]);
  const location = useLocation();
  const joinPassword: string | null = (location.state as { password?: string } | null)?.password ?? null;
  const { profile, isSignedIn } = useDiscordAuth();
  const { discordPresenceEnabled, showFps } = usePreferences();
  const [handView, setHandView]         = useState<HandView | null>(null);
  const [lastLoaded, setLastLoaded]     = useState<LastLoaded | null>(null);
  const [historyService, setHistoryService] = useState<SceneHistoryService | null>(null);
  const [scriptSource, setScriptSource]     = useState<string>('');
  const [scriptErrorLog, setScriptErrorLog] = useState<ScriptErrorLog | null>(null);
  const [manifestStore, setManifestStore]   = useState<ManifestStore | null>(null);
  const [bundleStore, setBundleStore]       = useState<BundleStore | null>(null);
  const [bundleCache, setBundleCache]       = useState<BundleCache | null>(null);
  const [handle, setHandle]                 = useState<SceneHandle | null>(null);
  const [editingSeatIndex, setEditingSeatIndex] = useState<number | null>(null);

  // Selecting anything other than the Table tears down any in-flight seat
  // gizmo edit so the gizmo can't outlive its panel row.
  useEffect(() => {
    if (selectedId !== TABLE_ENTITY_ID && editingSeatIndex !== null) {
      setEditingSeatIndex(null);
    }
  }, [selectedId, editingSeatIndex]);

  // Camera snap on seat assignment. Fires once when the local player's seat
  // transitions to a new non-null seat (spectator → seated, or reseated to a
  // different index). Loss-of-seat is a no-op per PRD edge handling.
  useEffect(() => {
    if (!handle || !selfPeerId || !roomSnapshot) return;
    const seat = roomSnapshot.seats.find(s => s.peerId === selfPeerId)?.index ?? null;
    if (seat === null) { prevSelfSeatRef.current = null; return; }
    if (prevSelfSeatRef.current === seat) return;
    const table = handle.controller.get(TABLE_ENTITY_ID);
    const seats = table?.entity.getComponent(TableComponent)?.state.seats;
    const stored = seats?.[seat];
    if (!stored) return;
    const pose = seatPoseFromState(stored);
    const snap = computeOrbitForSeat(pose, 0, 0);
    snapCameraOrbitRef.current(snap.theta, snap.target);
    prevSelfSeatRef.current = seat;
  }, [roomSnapshot, selfPeerId, handle]);
  const [inspectDialog, setInspectDialog] = useState<{
    deckId:   string;
    deckName: string;
    snapshot: Record<string, { face: string; back: string }>;
  } | null>(null);

  const managerRef         = useRef<RoomStateManager | null>(null);

  const sendRef            = useRef<(msg: ChannelMessage, opts?: { reliable?: boolean }) => void>(noop);
  const sendToRef          = useRef<(peerId: string, msg: ChannelMessage, opts?: { reliable?: boolean }) => void>(noop);
  const getTargetsRef      = useRef<() => ReplicationTarget[]>(() => []);
  const getSelfSeatRef     = useRef<() => SeatIndex | null>(() => null);
  const getSelfPeerIdRef   = useRef<() => string | null>(() => null);
  const getPeerSeatRef     = useRef<(peerId: string) => SeatIndex | null>(() => null);
  const getRoomSnapshotRef = useRef<() => RoomStateSnapshot | null>(() => null);
  const getEditingSeatIndexRef = useRef<() => number | null>(() => null);
  const snapCameraOrbitRef = useRef<(theta: number, target: { x: number; y: number; z: number }) => void>(noop);
  // Tracks the local player's last-applied seat to gate the camera snap. null
  // means "spectator (or unknown)"; this state lives outside React render so
  // a snapshot fan-out doesn't re-trigger the snap.
  const prevSelfSeatRef = useRef<SeatIndex | null>(null);
  const onMsgRef           = useRef<(peerId: string, msg: ChannelMessage) => void>(noop);
  const onPeerLeftRef      = useRef<(peerId: string) => void>(noop);
  const onPeerJoinedRef    = useRef<(peerId: string) => void>(noop);
  const onContextMenuRef   = useRef<(req: ContextMenuRequest) => void>(noop);
  // Hot-keys yield while the React context menu is open (issue #3 of
  // issues--hotkeys.md). Ref re-assigned each render below so the canvas
  // effect sees the latest open-state without re-running.
  const isMenuOpenRef      = useRef<() => boolean>(() => false);
  const freeCameraRef      = useRef<(on: boolean) => void>(noop);
  const onSelectRef        = useRef<(id: string | null, modifier: SelectionClickModifier) => void>(noop);
  const onMarqueeCommitRef = useRef<(candidates: ReadonlySet<string>, modifier: SelectionClickModifier) => void>(noop);
  const setSelectionRef    = useRef<(ids: ReadonlySet<string>) => void>(noop);
  const setMarqueeCandidatesRef = useRef<(ids: ReadonlySet<string>) => void>(noop);
  const onEntityRemovedRef = useRef<(id: string) => void>(noop);
  const setActiveToolRef   = useRef<(toolId: string) => boolean>(() => false);
  const getActiveToolRef   = useRef<() => string>(() => activeToolId);
  const getCameraAxesRef   = useRef<() => { forward: [number, number, number]; right: [number, number, number] } | null>(() => null);
  const hasActiveGestureRef = useRef<() => boolean>(() => false);
  const setShowAllZonesRef = useRef<(on: boolean) => void>(noop);
  const setShowSnapPointsRef = useRef<(on: boolean) => void>(noop);
  const setShowHitboxesRef = useRef<(on: boolean) => void>(noop);
  const setHandViewRef     = useRef<(view: HandView | null) => void>(noop);
  const claimSeatRef       = useRef<(seatIndex: SeatIndex) => void>(noop);
  const kickPeerRef        = useRef<(peerId: string) => void>(noop);
  const banPeerRef         = useRef<(peerId: string) => void>(noop);
  const manifestStoreRef   = useRef<ManifestStore | null>(null);
  // Per-viewer "Open in Overlay" controller (Issue #9). Stable identity
  // for the lifetime of the Room — never replicated.
  const pdfOverlayController = useRef(new PdfOverlayController()).current;
  const connectionManagerRef = useRef<ConnectionManager | null>(null);
  const endTurnRef         = useRef<() => void>(noop);
  const dispatchTurnRef    = useRef<(action: TurnAction) => void>(noop);
  const setRoomNameRef     = useRef<(name: string) => void>(noop);
  const setRoomPasswordRef = useRef<(password: string | null) => void>(noop);
  const unbanRef           = useRef<(name: string) => void>(noop);

  // Set every render — fine, it's just a ref assignment.
  onContextMenuRef.current   = (req) => setContextMenu(req);
  isMenuOpenRef.current      = () => contextMenu !== null;
  onSelectRef.current        = (id, modifier) => {
    selectionStore.setState(applySelectionClick({
      state:    selectionStore.ids(),
      targetId: id,
      modifier,
    }));
  };
  onMarqueeCommitRef.current = (candidates, modifier) => {
    selectionStore.setState(applySelectionMarquee({
      state:    selectionStore.ids(),
      candidates,
      modifier,
    }));
  };
  getActiveToolRef.current   = () => activeToolId;
  setHandViewRef.current     = (view) => setHandView(view);
  getRoomSnapshotRef.current = () => roomSnapshot;
  getEditingSeatIndexRef.current = () => editingSeatIndex;

  const objects = useSceneObjects(handle?.controller ?? null, isHost);

  // Mirror the host's history service into React state. The service instance
  // itself doesn't change while a handle is mounted, so a single subscribe
  // suffices; gated on host because guests have no history surface.
  useEffect(() => {
    if (!handle || !isHost) {
      setHistoryService(null);
      setLastLoaded(null);
      return;
    }
    const history = handle.controller.history;
    setHistoryService(history);
    if (!history) return;
    setLastLoaded(history.lastLoaded);
    return history.subscribe(() => {
      setLastLoaded(history.lastLoaded);
    });
  }, [handle, isHost]);

  // Mirror the host script error log into React state. Like history, the log
  // instance is stable across the handle's lifetime; resubscribe only when
  // handle swaps (e.g. StrictMode double-mount).
  useEffect(() => {
    if (!handle || !isHost) {
      setScriptErrorLog(null);
      return;
    }
    setScriptErrorLog(handle.controller.scripting?.errorLog ?? null);
  }, [handle, isHost]);

  // Frozen-identity-per-session: snapshot the avatar URL at mount and never
  // change it for this room's lifetime. profile is deliberately not in this
  // effect's deps so a mid-session profile change does not force a rejoin.
  const profileAvatarUrlRef = useRef<string | null>(profile?.avatarUrl ?? null);
  profileAvatarUrlRef.current = profile?.avatarUrl ?? null;

  useEffect(() => {
    const selfDisplayName = loadDisplayName();
    const selfAvatarUrl   = profileAvatarUrlRef.current;
    let manager: RoomStateManager | null = null;
    let client:  RoomStateClient  | null = null;
    let mgr!: ConnectionManager;

    mgr = new ConnectionManager(
      (peerId, msg) => {
        const m = msg as ChannelMessage;
        if (m.type === 'room-state') {
          client?.applySnapshot(m.snapshot);
          if (client) console.log('[RoomState] my seat:', client.getMySeat());
          return;
        }
        if (m.type === 'room-state-patch') {
          client?.applyPatch(m.patch);
          if (client) console.log('[RoomState] my seat:', client.getMySeat());
          return;
        }
        if (m.type === 'seat-claim-request') {
          if (manager) {
            manager.claimSeat(peerId, m.seatIndex);
            // No reply: the resulting patch (if any) broadcasts to all peers via
            // the manager's onChange listener.
          }
          return;
        }
        if (m.type === 'end-turn-request') {
          if (manager && handleRef.current) {
            if (!manager.getTurns().enabled) return;
            const seat = manager.getSeat(peerId);
            if (seat === null) return;
            if (manager.getTurns().activeSeat !== seat) return;
            const scripting = handleRef.current.controller.scripting;
            if (scripting) {
              scripting.dispatchEndTurnRequest(seat, 'player');
            } else {
              manager.dispatchTurnAction({ kind: 'next', endedBy: 'player' });
            }
          }
          return;
        }
        if (m.type === 'kicked') {
          setStatus('disconnected');
          return;
        }
        if (m.type === 'manifest-publish') {
          manifestStoreRef.current?.applyPublishedSnapshot(m.snapshot);
          return;
        }
        onMsgRef.current(peerId, m);
      },
      (s) => setStatus(s as Status),
      (peerId) => {
        manager?.removePeer(peerId);
        // World peer-cleanup goes through the controller; the renderer ref
        // covers cursor cleanup that lives outside the World.
        handleRef.current?.controller.releasePeer(peerId);
        onPeerLeftRef.current(peerId);
      },
      (peerId, displayName, avatarUrl) => {
        if (!manager) return;
        if (manager.isBanned(peerId)) {
          mgr.sendTo(peerId, { type: 'kicked', reason: 'ban' } satisfies RoomStateMessage);
          mgr.kickPeer(peerId);
          return;
        }
        manager.assignOnJoin(peerId, displayName, avatarUrl);
        const snapshotMsg: RoomStateMessage = { type: 'room-state', snapshot: manager.snapshot() };
        mgr.sendTo(peerId, snapshotMsg);
        const manifestSnap = manifestStoreRef.current?.getPublished().toArray() ?? [];
        if (manifestSnap.length > 0) {
          mgr.sendTo(peerId, { type: 'manifest-publish', snapshot: manifestSnap });
        }
        onPeerJoinedRef.current(peerId);
      },
      (peerId) => {
        setSelfPeerId(peerId);
        if (isHost) {
          manager = new RoomStateManager(peerId, selfDisplayName, selfAvatarUrl ?? undefined);
          managerRef.current = manager;
          manager.onChange((change) => {
            const patchMsg: RoomStateMessage = { type: 'room-state-patch', patch: change.patch };
            mgr.send(patchMsg);
            setRoomSnapshot(change.snapshot);
          });
          manager.onTurnEvent((event: TurnEvent) => {
            handleRef.current?.controller.scripting?.dispatchTurnEvent(event);
          });
          // Wire the turn-tracker bridge into the ScriptHost so `scene.turns`
          // dispatches reach the manager's pure reducer.
          const m = manager;
          handleRef.current?.controller.scripting?.setTurnsBridge({
            dispatch: (action) => m.dispatchTurnAction(action),
            getState: () => m.getTurns(),
          });
          setRoomSnapshot(manager.snapshot());
          console.log('[RoomState] my seat:', manager.getSeat(peerId));
        } else {
          client = new RoomStateClient(peerId);
          client.onChange(snap => setRoomSnapshot(snap));
        }
      },
      (settings) => {
        setRoomName(settings.name);
        setHasPassword(settings.hasPassword);
      },
      (next) => setBans(next),
    );
    setRoomNameRef.current     = (name)     => mgr.setRoomName(name);
    setRoomPasswordRef.current = (password) => mgr.setRoomPassword(password);
    unbanRef.current           = (name)     => mgr.unban(name);
    sendRef.current     = (msg, opts)         => mgr.send(msg, opts);
    sendToRef.current   = (peerId, msg, opts) => mgr.sendTo(peerId, msg, opts);
    getTargetsRef.current = () => {
      if (!manager) return [];
      return mgr.getPeerIds().map(peerId => ({
        peerId,
        peerSeat: manager!.getSeat(peerId),
        isHost:   manager!.isHost(peerId),
      }));
    };
    getSelfSeatRef.current = () => {
      if (manager) return manager.getSeat(mgr.getPeerId() ?? '');
      return client?.getMySeat() ?? null;
    };
    getSelfPeerIdRef.current = () => mgr.getPeerId();
    getPeerSeatRef.current = (peerId) => manager?.getSeat(peerId) ?? null;

    claimSeatRef.current = (seatIndex) => {
      if (manager) {
        const self = mgr.getPeerId();
        if (self) manager.claimSeat(self, seatIndex);
        return;
      }
      mgr.send({ type: 'seat-claim-request', seatIndex } satisfies RoomStateMessage);
    };

    endTurnRef.current = () => {
      if (manager) {
        // Host clicking End Turn from their own button — route through the
        // script hook so endedBy='player' on the host matches the guest path.
        const self = mgr.getPeerId();
        if (!self) return;
        if (!manager.getTurns().enabled) return;
        const seat = manager.getSeat(self);
        if (seat === null || manager.getTurns().activeSeat !== seat) return;
        const scripting = handleRef.current?.controller.scripting;
        if (scripting) scripting.dispatchEndTurnRequest(seat, 'player');
        else manager.dispatchTurnAction({ kind: 'next', endedBy: 'player' });
        return;
      }
      mgr.send({ type: 'end-turn-request' } satisfies RoomStateMessage);
    };

    dispatchTurnRef.current = (action) => {
      if (!manager) return;
      manager.dispatchTurnAction(action);
    };

    kickPeerRef.current = (peerId) => {
      if (!manager) return;
      mgr.sendTo(peerId, { type: 'kicked', reason: 'kick' } satisfies RoomStateMessage);
      manager.removePeer(peerId);
      mgr.kickPeer(peerId);
    };

    banPeerRef.current = (peerId) => {
      if (!manager) return;
      // Tell the peer so they see the kick reason in the UI before the WS
      // drops; the server is the source of truth for the persistent ban.
      mgr.sendTo(peerId, { type: 'kicked', reason: 'ban' } satisfies RoomStateMessage);
      mgr.banPeer(peerId);
    };

    connectionManagerRef.current = mgr;
    mgr.setBundleTransportHandlers({
      onOpen: (peerId, transport) => {
        // Host's wire layer has already called transport.serve(...) for
        // every entry in the BundleStore. Guests latch the transport onto
        // AssetService so bundled-asset misses fall through to it.
        if (!isHost) {
          assetService.setBundleTransport(transport);
          // Pre-warm preload:true bundled entries in parallel so guests
          // don't pay the round-trip on first render. BundleCache hits
          // short-circuit inside AssetService.resolveBundleBlob, so this
          // is cheap on a warm re-join.
          const ms = manifestStoreRef.current;
          if (ms) {
            for (const e of ms.getDraft().toArray()) {
              if (e.bundled !== true || !e.preload) continue;
              if      (e.type === 'image') void assetService.resolve(e.slug, 'image');
              else if (e.type === 'model') void assetService.resolve(e.slug, 'model');
              else if (e.type === 'sound') void assetService.resolve(e.slug, 'sound');
            }
          }
        }
        // `peerId` unused for now but threaded so future routing (e.g.
        // mesh topologies) can pick the right transport per slug.
        void peerId;
      },
      onClose: (peerId) => {
        void peerId;
        if (!isHost) assetService.setBundleTransport(undefined);
      },
    });
    if (isHost) mgr.hostRoom(SIGNALING_URL, roomId, selfDisplayName, selfAvatarUrl);
    else        mgr.joinRoom(SIGNALING_URL, roomId, selfDisplayName, joinPassword, selfAvatarUrl);

    return () => {
      connectionManagerRef.current = null;
      mgr.dispose();
      sendRef.current          = noop;
      sendToRef.current        = noop;
      getTargetsRef.current    = () => [];
      getSelfSeatRef.current   = () => null;
      getSelfPeerIdRef.current = () => null;
      getPeerSeatRef.current   = () => null;
      claimSeatRef.current     = noop;
      kickPeerRef.current      = noop;
      banPeerRef.current       = noop;
      endTurnRef.current       = noop;
      dispatchTurnRef.current  = noop;
      setRoomNameRef.current   = noop;
      setRoomPasswordRef.current = noop;
      unbanRef.current         = noop;
      managerRef.current       = null;
      setRoomSnapshot(null);
      setSelfPeerId(null);
      setRoomName('');
      setHasPassword(false);
      setBans([]);
    };
  }, [roomId, isHost, joinPassword]);

  // Mirror the live handle into a ref for non-React consumers (the
  // ConnectionManager onLeft callback closes over the effect's scope but
  // needs to read the latest handle each call).
  const handleRef = useRef<SceneHandle | null>(null);
  useEffect(() => { handleRef.current = handle; }, [handle]);

  // Discord Rich Presence — start a controller while signed in + toggle on,
  // stop on either turning off. The presence string itself is refreshed via
  // the snapshot-watching effect below; the controller throttles internally.
  const presenceRef    = useRef<RichPresenceController | null>(null);
  const joinedAtMsRef  = useRef<number>(0);
  useEffect(() => {
    if (!isSignedIn || !discordPresenceEnabled) return;
    const ctrl = new RichPresenceController();
    presenceRef.current   = ctrl;
    joinedAtMsRef.current = Date.now();
    // Seed with placeholder counts — the snapshot effect below replaces
    // these as soon as room-state arrives.
    ctrl.start({
      roomName:    roomName || 'Room',
      playerCount: 1,
      capacity:    SEAT_COUNT,
      joinedAtMs:  joinedAtMsRef.current,
      logoKey:     'board_together_logo',
    });
    return () => {
      ctrl.stop();
      presenceRef.current = null;
    };
  }, [isSignedIn, discordPresenceEnabled]);

  // Refresh the presence whenever the snapshot or room name changes.
  useEffect(() => {
    const ctrl = presenceRef.current;
    if (!ctrl) return;
    const playerCount = roomSnapshot
      ? roomSnapshot.seats.filter(s => s.peerId !== null).length
      : 1;
    ctrl.update({
      roomName:    roomName || 'Room',
      playerCount,
      capacity:    SEAT_COUNT,
      joinedAtMs:  joinedAtMsRef.current || Date.now(),
      logoKey:     'board_together_logo',
    });
  }, [roomSnapshot, roomName, isSignedIn, discordPresenceEnabled]);

  // Wire canvas-side auto-remove to the store. The canvas detects when an
  // id in the live selection no longer maps to a world entity and reports
  // it here; the store fires its subscribers and the BoxHelper map drops
  // the helper on the next setSelectionRef call.
  useEffect(() => {
    onEntityRemovedRef.current = (id: string) => selectionStore.remove(id);
  }, [selectionStore]);

  // Drive the canvas's highlight helpers from store state.
  useEffect(() => {
    setSelectionRef.current(selectedIds);
  }, [selectedIds]);

  // Selection grid-layout hotkey — bare digit `1..9` arranges the active
  // selection into a grid with the pressed digit as the column count.
  // Parallel in shape to the toolbar hotkey, but lives in Room because it
  // needs the SelectionStore, world handle, history service, and the
  // canvas's camera axes / gesture predicate refs in one place.
  useEffect(() => {
    if (!handle) return;
    const onKey = (e: KeyboardEvent) => {
      const cols = resolveLayoutHotkey(
        { key: e.key, repeat: e.repeat, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey },
        { textInputFocused: isTextInputFocused(), activeGesture: hasActiveGestureRef.current() },
      );
      if (cols === null) return;
      const axes = getCameraAxesRef.current();
      if (!axes) return;
      performSelectionLayout({
        world:      handle.controller,
        selection:  selectionStore.ids(),
        cameraAxes: axes,
        selfSeat:   getSelfSeatRef.current(),
        history:    handle.controller.history,
        columns:    cols,
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handle, selectionStore]);

  // Bundled-asset stack — both roles share an in-memory BundleStore (the
  // hot-path lookup for the AssetService bundled branch) and a persistent
  // BundleCache backed by IndexedDB. Host-authored uploads land pinned so
  // they survive LRU eviction; peer-fetched bytes (#10) land unpinned. The
  // store rehydrates synchronously from cache.list({pinned:true}) at boot
  // so refreshing the page mid-session preserves uploaded assets without a
  // re-upload.
  useEffect(() => {
    const cache = new BundleCache({ driver: new IdbBundleCacheDriver() });
    const store = new BundleStore();
    setBundleCache(cache);
    setBundleStore(store);
    assetService.setBundleStore(store);
    assetService.setBundleCache(cache);
    let cancelled = false;
    void cache.list({ pinned: true }).then((records) => {
      if (cancelled) return;
      for (const r of records) store.put(r.hash, r.blob);
      // Bundled entries that subscribed before rehydration finished went
      // 'broken' on miss. Invalidate them so they re-resolve through the
      // newly-populated store.
      const ms = manifestStoreRef.current;
      if (!ms) return;
      for (const e of ms.getDraft().toArray()) {
        if (e.bundled === true) assetService.invalidate(e.slug);
      }
    });
    return () => {
      cancelled = true;
      assetService.setBundleStore(undefined);
      assetService.setBundleCache(undefined);
      setBundleCache(null);
      setBundleStore(null);
    };
  }, []);

  // Host wiring: feed the BundleStore to ConnectionManager so every
  // peer's BundleTransport learns about authored content (initial set on
  // channel-open, plus push/delete deltas via subscribe()).
  useEffect(() => {
    if (!isHost) return;
    const mgr = connectionManagerRef.current;
    if (!mgr || !bundleStore) return;
    mgr.registerHostBundleStore(bundleStore);
    return () => { mgr.registerHostBundleStore(null); };
  }, [isHost, bundleStore]);

  // Manifest store — both roles. Host edits draft locally and pushes to peers
  // via the manager modal; guests receive published snapshots through
  // `applyPublishedSnapshot`. AssetService follows the draft so the host
  // sees locally staged additions immediately and guests resolve the latest
  // pushed catalog (where draft == published).
  useEffect(() => {
    const store = new ManifestStore();
    manifestStoreRef.current = store;
    setManifestStore(store);
    const refresh = () => {
      assetService.setManifests([BASE_MANIFEST, PRIMITIVE_MANIFEST, store.getDraft()]);
      // Issue #7 — kick off `preload: true` fetches whenever the catalog
      // changes (initial mount, host edits, guest applies a published
      // snapshot). The promise is intentionally fire-and-forget; gameplay
      // does not await it and the HUD indicator reflects progress.
      void assetService.preload([BASE_MANIFEST, PRIMITIVE_MANIFEST, store.getDraft()]);
    };
    refresh();
    const unsub = store.subscribe(refresh);
    return () => {
      unsub();
      manifestStoreRef.current = null;
      setManifestStore(null);
      assetService.setManifests([BASE_MANIFEST, PRIMITIVE_MANIFEST]);
    };
  }, []);

  const selectedTools: EditorToolItem[] = (() => {
    if (!isHost || !selectedId || !handle) return [];
    const entity = handle.controller.get(selectedId)?.entity;
    if (!entity) return [];
    return aggregateEditorTools(entity, {
      recipientSeat: getSelfSeatRef.current(),
      isHost:        true,
      entity,
    });
  })();

  const handleToolAction = (item: EditorToolItem, value?: unknown) => {
    if (!selectedId || !handle) return;
    dispatchEditorTool(item, value, selectedId, {
      entity:    handle.controller.get(selectedId)?.entity,
      hostLocal: {
        attachSurface:    (id) => { handle.controller.attachSurface(id); },
        attachElement:    (id, kind) => { handle.controller.attachElement(id, kind); },
        attachSnapPoints: (id) => { handle.controller.attachSnapPoints(id); },
      },
      notify: () => handle.controller.requestRefresh(),
    });
  };

  const handleContextAction = (
    item: MenuItem & { kind: 'action' | 'colorpicker' },
    args: object | undefined,
  ) => {
    if (!contextMenu) return;
    // Multi-selection fan-out: when the right-clicked entity is part of the
    // current multi-selection, the menu action applies to every selected id.
    // A right-click on an unselected entity stays single-target — matches
    // the typical desktop convention where right-clicking outside the
    // selection acts on that one entity. Colorpicker is excluded from the
    // fan-out: batch property editing is explicitly out of scope.
    const fanOut = selectedIds.size > 1
                && selectedIds.has(contextMenu.entityId)
                && item.kind !== 'colorpicker';
    const targetIds = fanOut ? [...selectedIds] : [contextMenu.entityId];
    // Group Duplicate goes through the layout-preserving World path and
    // swaps the active selection to the new copies. Skips the per-entity
    // dispatch loop because each per-id call would apply its own offset.
    if (fanOut && item.kind === 'action' && item.id === '__duplicate' && handle) {
      const newIds = handle.controller.duplicateEntities(targetIds);
      if (newIds.length > 0) selectionStore.setState(new Set(newIds));
      return;
    }
    for (const id of targetIds) {
      // Components decide effect — actions that can't apply silently skip.
      // The singleton Table is undeletable; skip it explicitly here rather
      // than throwing from the world layer.
      if (item.kind === 'action' && item.id === '__delete' && id === TABLE_ENTITY_ID) continue;
      dispatchMenuAction(item, args, id, {
        isHost,
        entity:   handle?.controller.get(id)?.entity,
        send:     (msg) => sendRef.current(msg),
        hostLocal: {
          delete:        (eid) => handle?.controller.despawn(eid),
          duplicate:     (eid) => { handle?.controller.duplicateEntity(eid); },
          drawFromDeck:  (deckId, count, seat) => handle?.controller.drawFromDeck(deckId, count, seat),
          shuffleDeck:   (deckId, seat) => handle?.controller.shuffleDeck(deckId, seat),
          dealFromDeck:  (deckId, count, seat) => handle?.controller.dealFromDeck(deckId, count, seat),
          spreadDeck:    (deckId, seat) => handle?.controller.spreadDeck(deckId, seat),
          inspectDeck:   (deckId) => openInspectDialog(deckId),
        },
        selfSeat: getSelfSeatRef.current(),
      });
    }
  };

  // Editor panel group action callbacks. Each iterates the active selection
  // and dispatches the per-entity verb; unsupported entities (Table for
  // delete, anything without a tween for flip, etc.) silently no-op.
  const fanOutSelection = (action: (id: string) => void) => {
    for (const id of selectedIds) action(id);
  };
  const handleGroupFlip = () => {
    if (!handle) return;
    const selfSeat = getSelfSeatRef.current();
    fanOutSelection((id) => {
      dispatchAction(id, 'mesh', 'flip', {
        isHost,
        entity:   handle.controller.get(id)?.entity,
        send:     (msg) => sendRef.current(msg),
        selfSeat,
      });
    });
  };
  const handleGroupDelete = () => {
    if (!handle) return;
    fanOutSelection((id) => {
      if (id === TABLE_ENTITY_ID) return;
      handle.controller.despawn(id);
    });
  };
  const handleGroupDuplicate = () => {
    if (!handle) return;
    if (selectedIds.size <= 1) {
      fanOutSelection((id) => { handle.controller.duplicateEntity(id); });
      return;
    }
    // Layout-preserving duplicate — single shared world offset applied to
    // every clone. The new copies replace the active selection so the user
    // can drag / rotate them as a group immediately.
    const newIds = handle.controller.duplicateEntities([...selectedIds]);
    if (newIds.length > 0) selectionStore.setState(new Set(newIds));
  };

  const openInspectDialog = async (deckId: string) => {
    if (!handle) return;
    const seat = getSelfSeatRef.current();
    if (seat === null) return;
    const reply = await handle.controller.openInspect(deckId, seat);
    if (!reply || !reply.snapshot) return;  // silent dismiss on rejection
    const deck = handle.controller.get(deckId)?.entity;
    setInspectDialog({
      deckId,
      deckName: deck?.name ?? 'Deck',
      snapshot: reply.snapshot,
    });
  };

  const closeInspectDialog = () => {
    if (!inspectDialog) return;
    const seat = getSelfSeatRef.current();
    if (seat !== null && handle) {
      handle.controller.closeInspect(inspectDialog.deckId, seat);
    }
    setInspectDialog(null);
  };

  // Auto-close when the deck despawns out from under the dialog.
  useEffect(() => {
    if (!inspectDialog || !handle) return;
    const update = () => {
      if (!handle.controller.get(inspectDialog.deckId)) {
        setInspectDialog(null);
      }
    };
    return handle.controller.subscribe(update);
  }, [inspectDialog, handle]);

  const handleToggleFreeCamera = (on: boolean) => {
    setIsFreeCamera(on);
    freeCameraRef.current(on);
  };

  const handleSelectTool = (toolId: string) => {
    if (toolId === activeToolId) return;
    if (setActiveToolRef.current(toolId)) setActiveToolId(toolId);
  };

  const handleToggleShowAllZones = (on: boolean) => {
    setShowAllZones(on);
    setShowAllZonesRef.current(on);
  };

  const handleToggleShowSnapPoints = (on: boolean) => {
    setShowSnapPoints(on);
    setShowSnapPointsRef.current(on);
  };

  const handleToggleShowHitboxes = (on: boolean) => {
    setShowHitboxes(on);
    setShowHitboxesRef.current(on);
  };

  // Composes a hand-tile context menu via the same aggregator the 3D path
  // uses, so component-contributed items appear identically. Replaces the old
  // `requestHandTileMenuRef` indirection.
  const handleHandTileContextMenu = (entityId: string, x: number, y: number) => {
    if (!handle) return;
    const entity = handle.controller.get(entityId)?.entity;
    if (!entity) return;
    const seat = getSelfSeatRef.current();
    const items = aggregateContextMenu(entity, {
      recipientSeat: seat, isHost, entity,
      preferences:   loadPreferences(),
    });
    if (items.length === 0) return;
    setContextMenu({
      x, y,
      entityId:   entity.id,
      entityName: entity.name,
      entityTags: [...entity.tags],
      items,
    });
  };

  const shareUrl = (() => {
    const u = new URL(window.location.href);
    u.searchParams.delete('host');
    return u.toString();
  })();

  return (
    <div className="room">
      <ThreeCanvas
        isHost={isHost}
        sendRef={sendRef}
        sendToRef={sendToRef}
        getTargetsRef={getTargetsRef}
        getSelfSeatRef={getSelfSeatRef}
        getSelfPeerIdRef={getSelfPeerIdRef}
        getPeerSeatRef={getPeerSeatRef}
        getRoomSnapshotRef={getRoomSnapshotRef}
        getEditingSeatIndexRef={getEditingSeatIndexRef}
        snapCameraOrbitRef={snapCameraOrbitRef}
        onMsgRef={onMsgRef}
        onPeerLeftRef={onPeerLeftRef}
        onPeerJoinedRef={onPeerJoinedRef}
        onContextMenuRef={onContextMenuRef}
        isMenuOpenRef={isMenuOpenRef}
        freeCameraRef={freeCameraRef}
        onSelectRef={onSelectRef}
        onMarqueeCommitRef={onMarqueeCommitRef}
        setSelectionRef={setSelectionRef}
        setMarqueeCandidatesRef={setMarqueeCandidatesRef}
        onEntityRemovedRef={onEntityRemovedRef}
        setActiveToolRef={setActiveToolRef}
        getActiveToolRef={getActiveToolRef}
        getCameraAxesRef={getCameraAxesRef}
        hasActiveGestureRef={hasActiveGestureRef}
        setShowAllZonesRef={setShowAllZonesRef}
        setShowSnapPointsRef={setShowSnapPointsRef}
        setShowHitboxesRef={setShowHitboxesRef}
        setHandViewRef={setHandViewRef}
        onSceneReady={setHandle}
        pdfOverlayController={pdfOverlayController}
      />

      <AnchorLayout>
        <UIPanel anchor="top-center" order={0}>
          <div className={`room__status room__status--${status}`}>
            {roomName ? <span className="room__name">{roomName}</span> : null}
            <span>{STATUS_LABEL[status]}</span>
          </div>
        </UIPanel>

        {isHost && handle && (
          <UIPanel anchor="top-center" order={10}>
            <HostActionBar
              handle={handle}
              showAllZones={showAllZones}
              onToggleShowAllZones={handleToggleShowAllZones}
              showSnapPoints={showSnapPoints}
              onToggleShowSnapPoints={handleToggleShowSnapPoints}
              showHitboxes={showHitboxes}
              onToggleShowHitboxes={handleToggleShowHitboxes}
              onLoad={(envelope, filename, bundles) => {
                handle.controller.history?.setLastLoaded({
                  snapshot: envelope.scene,
                  filename,
                  savedAt:  envelope.savedAt,
                });
                handle.controller.replaceScene(envelope.scene);
                void handle.controller.scripting?.loadScript(envelope.script);
                setScriptSource(envelope.script.source);
                manifestStoreRef.current?.loadFromSave(envelope.manifest);
                managerRef.current?.hydrateTurns(envelope.turns);
                // Pump verified bundle blobs into the in-memory store +
                // pinned cache so AssetService's bundled branch resolves
                // them this session, and the next session rehydrates from
                // IDB. Hash verification + orphan filtering already
                // happened inside decodeSaveZip. loadFromSave above fired
                // a manifest refresh that invalidated each slug before the
                // blobs landed (so they went broken on miss); re-invalidate
                // every bundled slug so the resolution path takes another
                // pass with the now-populated store.
                if (bundleStore && bundleCache && bundles.length > 0) {
                  for (const b of bundles) {
                    bundleStore.put(b.hash, b.blob);
                    void bundleCache.put(b.hash, b.blob, { pinned: true });
                  }
                  for (const e of envelope.manifest) {
                    if (e.bundled === true) assetService.invalidate(e.slug);
                  }
                }
              }}
              onRevert={() => handle.controller.history?.revert()}
              lastLoaded={lastLoaded}
              currentEntityCount={objects.length}
              historyService={historyService}
              scriptSource={scriptSource}
              onScriptChange={setScriptSource}
              scriptErrorLog={scriptErrorLog}
              manifestStore={manifestStore}
              bundleStore={bundleStore ?? undefined}
              bundleCache={bundleCache ?? undefined}
              onPushManifest={() => {
                const store = manifestStoreRef.current;
                if (!store) return;
                const snapshot = store.push();
                sendRef.current({ type: 'manifest-publish', snapshot });
              }}
              turnControls={(controlled) => (
                <TurnControlsPanel
                  snapshot={roomSnapshot}
                  onEnable={() => dispatchTurnRef.current({ kind: 'enable' })}
                  onDisable={() => dispatchTurnRef.current({ kind: 'disable', endedBy: 'host' })}
                  onEndCurrent={() => {
                    // Route through the script hook so a script that gates
                    // end-of-turn can still veto the host's button.
                    const turns = roomSnapshot?.turns;
                    if (!turns?.enabled || turns.activeSeat === null) return;
                    const scripting = handle.controller.scripting;
                    if (scripting) scripting.dispatchEndTurnRequest(turns.activeSeat, 'host');
                    else dispatchTurnRef.current({ kind: 'next', endedBy: 'host' });
                  }}
                  onJumpToSeat={(seat) => dispatchTurnRef.current({ kind: 'setActive', seat, endedBy: 'host' })}
                  onSetOrder={(order) => dispatchTurnRef.current({ kind: 'setOrder', order })}
                  {...controlled}
                />
              )}
              turns={roomSnapshot?.turns}
              roomName={roomName}
              onRenameRoom={(name) => setRoomNameRef.current(name)}
              hasPassword={hasPassword}
              onSetRoomPassword={(password) => setRoomPasswordRef.current(password)}
              bans={bans}
              onUnban={(name) => unbanRef.current(name)}
            />
          </UIPanel>
        )}

        {isHost && handle && (
          <UIPanel anchor="top-left" order={10}>
            <EditorPanel
              objects={objects}
              selectedIds={selectedIds}
              isFreeCamera={isFreeCamera}
              manifestStore={manifestStore}
              selectedTools={selectedTools}
              getTableBounds={() => handle.controller.getTableBounds()}
              roomSnapshot={roomSnapshot}
              editingSeatIndex={editingSeatIndex}
              onSetEditingSeatIndex={setEditingSeatIndex}
              onSelect={setSelectedId}
              onRollDice={() => handle.controller.forEach((h) => h.entity.getComponent(DiceComponent)?.roll())}
              onUpdateEntityField={(id, key, value) => handle.controller.updateEntityField(id, key, value)}
              onUpdateComponentProp={(id, typeId, key, value) =>
                handle.controller.updateComponentProp(id, typeId, key, value)}
              onToggleFreeCamera={handleToggleFreeCamera}
              onToolAction={handleToolAction}
              onMutateElement={(sid, eid, patch) => handle.controller.mutateSurfaceElement(sid, eid, patch)}
              onRemoveElement={(sid, eid) => handle.controller.removeSurfaceElement(sid, eid)}
              onDeleteEntity={(id) => handle.controller.despawn(id)}
              onDuplicateEntity={(id) => { handle.controller.duplicateEntity(id); }}
              onGroupFlip={handleGroupFlip}
              onGroupDelete={handleGroupDelete}
              onGroupDuplicate={handleGroupDuplicate}
            />
          </UIPanel>
        )}

        <UIPanel anchor="top-center" order={20}>
          <EndTurnButton
            snapshot={roomSnapshot}
            selfSeat={getSelfSeatRef.current()}
            onEndTurn={() => endTurnRef.current()}
          />
        </UIPanel>

        {showFps && (
          <UIPanel anchor="top-right" order={-10}>
            <FpsCounter />
          </UIPanel>
        )}

        <UIPanel anchor="top-right" order={0}>
          <PreferencesTrigger />
        </UIPanel>

        <UIPanel anchor="top-right" order={10}>
          <PlayersPanel
            snapshot={roomSnapshot}
            selfPeerId={selfPeerId}
            isHost={isHost}
            onClaimSeat={(idx) => claimSeatRef.current(idx)}
            onKick={(id) => kickPeerRef.current(id)}
            onBan={(id) => banPeerRef.current(id)}
          />
        </UIPanel>

        <UIPanel anchor="bottom-left" order={10}>
          <Toolbar activeToolId={activeToolId} onSelectTool={handleSelectTool} />
        </UIPanel>

        <UIPanel anchor="bottom-right" order={20}>
          <AssetLoadingIndicator />
        </UIPanel>

        <PdfOverlaySheet controller={pdfOverlayController} />

        {isHost && status === 'connecting' && (
          <UIPanel anchor="bottom-center" order={10}>
            <div className="room__share">
              <div className="room__share-label">Share this link with your guest:</div>
              <div className="room__share-url">{shareUrl}</div>
            </div>
          </UIPanel>
        )}

        {handView && (
          <UIPanel anchor="bottom-center" order={20}>
            <HandPanel
              cards={handView.cards}
              selectedId={selectedId}
              onSelectTile={(id) => setSelectedId(id)}
              onTileContextMenu={handleHandTileContextMenu}
              onPlayCardToTable={(id, x, y) => handle?.playCardToTableAtScreen(id, x, y)}
              onReorderHand={(newOrder) => handle?.controller.reorderHand(handView.handEntityId, newOrder)}
              handEntityId={handView.handEntityId}
              onTileInputEvent={(id, name, payload) => {
                const entity = handle?.controller.get(id)?.entity;
                if (!entity) return;
                handle.controller.fireInputEvent(entity, name, payload);
              }}
              selfSeat={getSelfSeatRef.current()}
            />
          </UIPanel>
        )}
      </AnchorLayout>

      {contextMenu && (
        <ContextMenu
          menu={contextMenu}
          onAction={handleContextAction}
          onDismiss={() => setContextMenu(null)}
        />
      )}
      {inspectDialog && (
        <div
          style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 100,
            pointerEvents: 'auto',
          }}
        >
          <InspectDeckDialog
            deckName={inspectDialog.deckName}
            getCardIds={() =>
              handle?.controller.get(inspectDialog.deckId)?.entity
                ?.getComponent(DeckComponent)?.state.cards ?? []
            }
            snapshot={inspectDialog.snapshot}
            onClose={closeInspectDialog}
            onReorder={(newOrder) => {
              const seat = getSelfSeatRef.current();
              if (seat === null) return;
              handle?.controller.reorderDeck(inspectDialog.deckId, newOrder, seat);
            }}
            onExtract={(cardId, clientX, clientY) => {
              const seat = getSelfSeatRef.current();
              if (seat === null) return;
              handle?.extractFromDeckAtScreen(inspectDialog.deckId, cardId, clientX, clientY, seat);
            }}
          />
        </div>
      )}
    </div>
  );
}

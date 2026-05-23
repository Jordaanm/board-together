import { useEffect, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { PhysicsWorld } from './physics/PhysicsWorld';
import { createWorld } from './entity/world';
import { type World, type WorldInboundMessage, type SceneHandle } from './entity/world';
import { RtcTransport } from './entity/world';
import { type Entity } from './entity/Entity';
import { TransformComponent } from './entity/components/TransformComponent';
import { ZoneComponent } from './entity/components/ZoneComponent';
import { SnapPointsComponent } from './entity/components/SnapPointsComponent';
import { HandComponent } from './entity/components/HandComponent';
import { FlatViewComponent } from './entity/components/FlatViewComponent';
import { surfaceRenderQueue } from './entity/components/SurfaceRenderQueue';
import { captureCanvasThumbnail } from './entity/thumbnail';
import { type ContextMenuRequest } from './input/ContextMenuController';
import { type CardTile } from './components/HandPanel';
import { assetService } from './assets/AssetService';
import { SoundPlayer } from './assets/SoundPlayer';
import { DEFAULT_PRIVATE_FIELDS } from './seats/PrivacyScrubber';
import { MoveGizmo } from './scene/MoveGizmo';
import { CameraController } from './camera/CameraController';
import { ToolDispatcher, TOOL_CATALOGUE, type Tool } from './input/tools';
import { GrabTool } from './input/tools/GrabTool';
import { ContextMenuController } from './input/ContextMenuController';
import { InputDispatcher } from './input/InputDispatcher';
import { HotkeyDispatcher } from './input/HotkeyDispatcher';
import { CursorTracker } from './cursor/CursorTracker';
import { CursorOverlay } from './cursor/CursorOverlay';
import { PingOverlay } from './cursor/PingOverlay';
import { SeatOverlay } from './seats/SeatOverlay';
import { TableComponent } from './entity/components/TableComponent';
import { TABLE_ENTITY_ID } from './entity/tableEntity';
import { TABLE_SURFACE_Y } from './scene/Table';
import { type ChannelMessage } from './net/SceneState';
import { type SeatIndex } from './seats/SeatLayout';
import { type RoomStateSnapshot } from './seats/RoomState';

export interface ReplicationTarget {
  peerId:   string;
  peerSeat: SeatIndex | null;
  isHost:   boolean;
}

interface Props {
  isHost:              boolean;
  sendRef:             MutableRefObject<(msg: ChannelMessage, opts?: { reliable?: boolean }) => void>;
  sendToRef:           MutableRefObject<(peerId: string, msg: ChannelMessage, opts?: { reliable?: boolean }) => void>;
  getTargetsRef:       MutableRefObject<() => ReplicationTarget[]>;
  getSelfSeatRef:      MutableRefObject<() => SeatIndex | null>;
  getSelfPeerIdRef:    MutableRefObject<() => string | null>;
  getPeerSeatRef:      MutableRefObject<(peerId: string) => SeatIndex | null>;
  getRoomSnapshotRef:  MutableRefObject<() => RoomStateSnapshot | null>;
  onMsgRef:            MutableRefObject<(peerId: string, msg: ChannelMessage) => void>;
  onPeerLeftRef:       MutableRefObject<(peerId: string) => void>;
  onPeerJoinedRef:     MutableRefObject<(peerId: string) => void>;
  onContextMenuRef:    MutableRefObject<(req: ContextMenuRequest) => void>;
  isMenuOpenRef:       MutableRefObject<() => boolean>;
  freeCameraRef:       MutableRefObject<(on: boolean) => void>;
  onSelectRef:         MutableRefObject<(id: string | null) => void>;
  setHighlightRef:     MutableRefObject<(id: string | null) => void>;
  setActiveToolRef:    MutableRefObject<(toolId: string) => boolean>;
  getActiveToolRef:    MutableRefObject<() => string>;
  setShowAllZonesRef:  MutableRefObject<(on: boolean) => void>;
  setShowSnapPointsRef: MutableRefObject<(on: boolean) => void>;
  setShowHitboxesRef:  MutableRefObject<(on: boolean) => void>;
  setHandViewRef:      MutableRefObject<(view: HandView | null) => void>;
  // Fires after the World is constructed inside the canvas effect; null on
  // cleanup. Replaces the ~30 scene-mutate refs that used to thread through
  // ThreeCanvas. Issue #2 of issues--refactor-world-ref.md.
  onSceneReady?:       (handle: SceneHandle | null) => void;
}

export interface HandView {
  handEntityId: string;
  cards:        CardTile[];
}

export function ThreeCanvas({
  isHost, sendRef, sendToRef, getTargetsRef, getSelfSeatRef, getSelfPeerIdRef, getPeerSeatRef,
  getRoomSnapshotRef,
  onMsgRef, onPeerLeftRef, onPeerJoinedRef,
  onContextMenuRef,
  isMenuOpenRef,
  freeCameraRef,
  onSelectRef, setHighlightRef, setActiveToolRef, getActiveToolRef,
  setShowAllZonesRef,
  setShowSnapPointsRef,
  setShowHitboxesRef,
  setHandViewRef,
  onSceneReady,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // ── Renderer ─────────────────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);

    const camera = new THREE.PerspectiveCamera(
      60, container.clientWidth / container.clientHeight, 0.1, 1000,
    );

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    const hemiLight = new THREE.HemisphereLight(0xbfd9ff, 0x3a2e24, 0.55);
    scene.add(hemiLight);

    const rimLight = new THREE.DirectionalLight(0x9cc9ff, 0.35);
    rimLight.position.set(-6, 6, -4);
    scene.add(rimLight);

    const physicsWorld = isHost ? new PhysicsWorld() : null;

    const camController = new CameraController(camera, renderer.domElement);

    const cursorTracker = new CursorTracker();
    const cursorOverlay = new CursorOverlay(scene);
    const seatOverlay   = new SeatOverlay(scene);
    let   pingOverlay: PingOverlay | null = null;

    // Local pointer state — raycast onto the table plane and broadcast at
    // ~30Hz so peers see this user's cursor in real time.
    const cursorRay      = new THREE.Raycaster();
    const cursorPtrNDC   = new THREE.Vector2();
    const cursorPlane    = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TABLE_SURFACE_Y);
    const cursorHit      = new THREE.Vector3();
    let   cursorPending: { x: number; z: number } | null = null;
    let   cursorLastSent = 0;
    const CURSOR_INTERVAL_MS = 33;

    const onCursorMove = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      cursorPtrNDC.set(
        ((e.clientX - rect.left) / rect.width)  * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      cursorRay.setFromCamera(cursorPtrNDC, camera);
      if (!cursorRay.ray.intersectPlane(cursorPlane, cursorHit)) return;
      cursorPending = { x: cursorHit.x, z: cursorHit.z };
    };
    renderer.domElement.addEventListener('pointermove', onCursorMove);

    freeCameraRef.current = (on) => camController.setRestricted(on);

    // ── World transport ─────────────────────────────────────────────────
    // RtcTransport owns per-peer fan-out and privacy scrubbing internally.
    // Cursor traffic continues to flow outside the World (it isn't a
    // SceneMessage) and is dispatched directly in onMsgRef below.
    let worldRef: World | null = null;
    const transport = new RtcTransport({
      send:       (msg, opts) => sendRef.current(msg, opts),
      sendTo:     (peerId, msg, opts) => sendToRef.current(peerId, msg, opts),
      getTargets: isHost ? () => getTargetsRef.current() : () => [],
      getEntity:  (id) => worldRef?.get(id)?.entity,
      privateFieldRegistry: DEFAULT_PRIVATE_FIELDS,
    });

    const world: World = createWorld({
      role:        isHost ? 'host' : 'guest',
      scene,
      identity: {
        isHost,
        selfSeat:   () => getSelfSeatRef.current(),
        selfPeerId: () => getSelfPeerIdRef.current(),
      },
      transport,
      physics:     physicsWorld ?? undefined,
      getPeerSeat: isHost ? (peerId) => getPeerSeatRef.current(peerId) : undefined,
      captureThumb: isHost
        ? () => {
            // WebGLRenderer defaults to preserveDrawingBuffer:false, so the
            // canvas backbuffer is cleared after each rAF. Re-render before
            // capture so toDataURL reads a populated buffer instead of blank.
            renderer.render(scene, camera);
            return captureCanvasThumbnail(renderer.domElement, { width: 192, height: 108 });
          }
        : undefined,
    });
    worldRef = world;

    pingOverlay = new PingOverlay(scene, world);
    const unsubscribePing = world.onToolBroadcast((msg) => pingOverlay?.ingest(msg));

    // Issue #11 — every peer (host and guests) plays inbound sound
    // broadcasts locally. Resolves through the same AssetService cache the
    // manager modal and consumers use, so a `preload: true` sound is already
    // warm by the time playSound fires.
    const soundPlayer    = new SoundPlayer(assetService);
    const unsubscribeSnd = world.onPlaySound((msg) => soundPlayer.playSlug(msg.slug));

    // ── Selection highlight ─────────────────────────────────────────────
    // BoxHelper is tool-independent and renders directly from selection state.
    // The MoveGizmo overlay is owned by GrabTool's AxisGizmoAttachment, which
    // attaches/detaches as selection changes while the tool is active.
    let highlightHelper: THREE.BoxHelper | null = null;
    let highlightId:     string | null = null;
    const moveGizmo     = new MoveGizmo();

    const clearHighlightBox = () => {
      if (highlightHelper) {
        scene.remove(highlightHelper);
        highlightHelper.dispose();
        highlightHelper = null;
      }
    };

    const selectCallback = (id: string | null) => onSelectRef.current(id);

    // ── Input wiring ────────────────────────────────────────────────────
    // ToolDispatcher owns pointer events and routes left-click to the active
    // tool. Tool catalogue is a static array (issue 2a — only GrabTool today).
    const tools: Tool[] = TOOL_CATALOGUE.map(f => f.create({
      scene, moveGizmo, onSelect: selectCallback,
    }));
    const grabTool = tools.find(t => t.id === 'grab') as GrabTool;
    const dispatcher = new ToolDispatcher({
      world, scene, camera,
      element: renderer.domElement,
      getSelfSeat: () => getSelfSeatRef.current(),
    });
    dispatcher.setActiveTool(grabTool);

    // Parallel observer of pointer input — emits per-entity `pressed` /
    // `released` / `click` events on the same canvas events the tool
    // dispatcher consumes. Hover (issue #2) and dual-fire RPC (issue #4)
    // layer on top of this same instance.
    const inputDispatcher = new InputDispatcher({
      world, camera,
      element:     renderer.domElement,
      getSelfSeat: () => getSelfSeatRef.current(),
    });

    setActiveToolRef.current = (toolId) => {
      const tool = tools.find(t => t.id === toolId);
      if (!tool) return false;
      return dispatcher.setActiveTool(tool);
    };

    setHighlightRef.current = (id) => {
      if (highlightId === id) return;
      highlightId = id;
      ZoneComponent.selectedEntityId = id;
      clearHighlightBox();
      if (id) {
        const obj = world.get(id)?.get(TransformComponent)?.object3d;
        if (obj) {
          highlightHelper = new THREE.BoxHelper(obj, 0xffd740);
          (highlightHelper.material as THREE.LineBasicMaterial).linewidth = 2;
          scene.add(highlightHelper);
        }
      }
      grabTool.setSelection(id, dispatcher.getContext());
    };

    setShowAllZonesRef.current = (on) => { ZoneComponent.showAllZones = on; };
    setShowSnapPointsRef.current = (on) => { SnapPointsComponent.setShowAll(on); };
    setShowHitboxesRef.current = (on) => { grabTool.setShowHitboxes(on, dispatcher.getContext()); };

    // ── SceneHandle for React ──────────────────────────────────────────
    // Bundles the live World controller with renderer-bound helpers
    // (thumbnail capture, screen-coord card drop). Panels receive this via
    // Room's `onSceneReady` callback instead of threading 30+ refs.
    const playRay   = new THREE.Raycaster();
    const playNDC   = new THREE.Vector2();
    const playHit   = new THREE.Vector3();
    const tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TABLE_SURFACE_Y);
    const handle: SceneHandle = {
      controller: world,
      captureThumbnail: () => {
        // Same render-then-capture pattern as the host save path used to
        // run inline. Returns null on guest (no captureThumb is wired and
        // host-side panels gate on isHost before invoking).
        renderer.render(scene, camera);
        return captureCanvasThumbnail(renderer.domElement, { width: 480, height: 270 });
      },
      playCardToTableAtScreen: (entityId, clientX, clientY) => {
        const target = world.get(entityId);
        if (!target) return;
        const rect = renderer.domElement.getBoundingClientRect();
        playNDC.set(
           ((clientX - rect.left) / rect.width)  * 2 - 1,
          -((clientY - rect.top)  / rect.height) * 2 + 1,
        );
        playRay.setFromCamera(playNDC, camera);
        if (!playRay.ray.intersectPlane(tablePlane, playHit)) return;
        world.playCardToTable(target.entity, [playHit.x, playHit.y + 0.05, playHit.z]);
      },
      extractFromDeckAtScreen: (deckId, cardId, clientX, clientY, seat) => {
        const deck = world.get(deckId);
        if (!deck) return null;
        const rect = renderer.domElement.getBoundingClientRect();
        // Reject anything outside the canvas (the dialog has its own bounds
        // upstream, but a release in the browser chrome would yield a stale
        // plane intersection from the previous frame).
        if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
          return null;
        }
        playNDC.set(
           ((clientX - rect.left) / rect.width)  * 2 - 1,
          -((clientY - rect.top)  / rect.height) * 2 + 1,
        );
        playRay.setFromCamera(playNDC, camera);
        if (!playRay.ray.intersectPlane(tablePlane, playHit)) return null;
        // Drop on the locked deck itself → snap back. Use a small XZ
        // proximity check against the deck's transform rather than a
        // full mesh raycast.
        const deckTransform = deck.entity.getComponent(TransformComponent);
        if (deckTransform) {
          const dx = playHit.x - deckTransform.state.position[0];
          const dz = playHit.z - deckTransform.state.position[2];
          const DECK_RADIUS = 0.4;
          if (Math.hypot(dx, dz) < DECK_RADIUS) return null;
        }
        const hit: [number, number, number] = [playHit.x, playHit.y, playHit.z];
        world.extractFromDeck(deckId, cardId, hit, seat);
        return hit;
      },
    };
    onSceneReady?.(handle);

    const unsubscribe = world.subscribe(() => {
      if (highlightId && !world.get(highlightId)) {
        highlightId = null;
        clearHighlightBox();
        grabTool.setSelection(null, dispatcher.getContext());
      }
    });

    const contextCtrl = new ContextMenuController(
      renderer.domElement, camera, isHost, world,
      () => getSelfSeatRef.current(),
      (req) => onContextMenuRef.current(req),
    );

    // Canvas needs a tabIndex to receive keydown events. Also focus on
    // pointerdown so a click anywhere on the canvas (re-)claims keyboard
    // focus — natural transition back from chat / sidebar inputs.
    renderer.domElement.tabIndex = 0;
    renderer.domElement.style.outline = 'none';
    renderer.domElement.focus();
    const focusOnDown = () => renderer.domElement.focus();
    renderer.domElement.addEventListener('pointerdown', focusOnDown);

    const hotkeyDispatcher = new HotkeyDispatcher({
      world,
      element:      renderer.domElement,
      isHost,
      getSelfSeat:  () => getSelfSeatRef.current(),
      getHoveredId: () => inputDispatcher.getHoveredId(),
      isMenuOpen:   () => isMenuOpenRef.current(),
      send:         (msg) => sendRef.current(msg),
    });

    // ── Inbound message router ──────────────────────────────────────────
    // Cursor traffic stays here (not a SceneMessage). Everything else is
    // forwarded into worldTransport so World's inbound dispatch handles it.
    onMsgRef.current = (peerId, msg) => {
      if (msg.type === 'cursor-position') {
        if (isHost) {
          // Star topology: host relays each guest's cursor to all other peers.
          cursorTracker.update(msg.peerId, msg.seat, msg.x, msg.z, msg.tool);
          for (const t of getTargetsRef.current()) {
            if (t.peerId === peerId) continue;
            sendToRef.current(t.peerId, msg);
          }
        } else {
          if (msg.peerId === getSelfPeerIdRef.current()) return; // skip echo
          cursorTracker.update(msg.peerId, msg.seat, msg.x, msg.z, msg.tool);
        }
        return;
      }
      transport.deliver(peerId, msg as WorldInboundMessage);
    };

    // World peer cleanup is now driven directly by Room via
    // `handle.controller.releasePeer(peerId)`. This slot only handles the
    // renderer-side cursor cleanup that has no controller equivalent.
    onPeerLeftRef.current = (peerId) => {
      cursorTracker.remove(peerId);
    };

    onPeerJoinedRef.current = (peerId) => {
      transport.firePeerJoin(peerId);
    };

    // ── Animation loop ────────────────────────────────────────────────────
    let lastTime = performance.now();
    let animId: number;
    let lastHandViewKey = '__init';

    const animate = () => {
      animId = requestAnimationFrame(animate);

      const now = performance.now();
      const dt  = Math.min((now - lastTime) / 1000, 0.05);
      lastTime  = now;

      world.tick(dt);
      dispatcher.update(dt);
      inputDispatcher.update(dt);

      // ── Cursor: throttled send + render sync ───────────────────────────
      const cursorNow = performance.now();
      if (cursorPending && cursorNow - cursorLastSent >= CURSOR_INTERVAL_MS) {
        const selfPeerId = getSelfPeerIdRef.current();
        if (selfPeerId) {
          sendRef.current({
            type:   'cursor-position',
            peerId: selfPeerId,
            seat:   getSelfSeatRef.current(),
            x:      cursorPending.x,
            z:      cursorPending.z,
            tool:   getActiveToolRef.current(),
          });
        }
        cursorLastSent = cursorNow;
        cursorPending  = null;
      }
      cursorOverlay.sync(cursorTracker.all());
      pingOverlay?.update(dt);

      // SeatOverlay — disk + chevron markers visible only when the Table is
      // selected; per-occupied-seat name planes always visible. Reads stored
      // seat poses off the Table component and occupant / names off the
      // current RoomState snapshot.
      const tableHandle = world.get(TABLE_ENTITY_ID);
      const tableSeats  = tableHandle?.entity.getComponent(TableComponent)?.state.seats;
      const snap        = getRoomSnapshotRef.current();
      seatOverlay.sync({
        seats:    tableSeats,
        selected: highlightId === TABLE_ENTITY_ID,
        names:    resolveSeatNames(snap),
      });

      // Drive zone debug-mesh visibility from selection + global toggle.
      world.forEach((h) => h.entity.getComponent(ZoneComponent)?.updateDebugVisibility());

      // Hand panel — re-derive view each frame and push to React only when
      // the view's identity key changes. Cheap (one walk per frame).
      const view = deriveHandView(world, getSelfSeatRef.current());
      const key  = handViewKey(view);
      if (key !== lastHandViewKey) {
        lastHandViewKey = key;
        setHandViewRef.current(view);
      }

      if (highlightHelper) highlightHelper.update();

      // Drain UI-surface composition once per frame before rendering — element
      // setState / asset-resolve callbacks only flip dirty flags; nothing
      // composites unless someone drains the queue.
      surfaceRenderQueue.drain();

      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      const w = container.clientWidth, h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', onResize);
      renderer.domElement.removeEventListener('pointermove', onCursorMove);
      renderer.domElement.removeEventListener('pointerdown', focusOnDown);
      hotkeyDispatcher.dispose();
      onSceneReady?.(null);
      unsubscribePing();
      unsubscribeSnd();
      pingOverlay?.dispose();
      pingOverlay = null;
      seatOverlay.dispose();
      cursorOverlay.dispose();
      cursorTracker.clear();
      unsubscribe();
      clearHighlightBox();
      dispatcher.dispose();
      inputDispatcher.dispose();
      moveGizmo.dispose();
      camController.dispose();
      contextCtrl.dispose();
      world.dispose();
      onMsgRef.current        = () => {};
      onPeerLeftRef.current   = () => {};
      onPeerJoinedRef.current = () => {};
      freeCameraRef.current      = () => {};
      setHighlightRef.current    = () => {};
      setActiveToolRef.current   = () => false;
      getActiveToolRef.current   = () => 'grab';
      renderer.dispose();
      container.removeChild(renderer.domElement);
      ZoneComponent.selectedEntityId = null;
      ZoneComponent.showAllZones     = false;
      SnapPointsComponent.setShowAll(false);
    };
  }, [
    isHost, sendRef, sendToRef, getTargetsRef, getSelfSeatRef, getSelfPeerIdRef, getPeerSeatRef,
    getRoomSnapshotRef,
    onMsgRef, onPeerLeftRef, onPeerJoinedRef,
    onContextMenuRef,
    isMenuOpenRef,
    freeCameraRef,
    onSelectRef, setHighlightRef, setActiveToolRef, getActiveToolRef,
    setShowAllZonesRef, setShowSnapPointsRef, setShowHitboxesRef, setHandViewRef,
    onSceneReady,
  ]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}

// Resolves the viewer's main hand entity and its current contents into a
// HandView for the bottom-center hand panel. Returns null when the viewer has
// no main hand (unseated, or seated with no isMainHand=true hand).
function deriveHandView(world: World, selfSeat: SeatIndex | null): HandView | null {
  if (selfSeat === null) return null;
  let mainHand: Entity | null = null;
  world.forEach((h) => {
    if (mainHand) return;
    const e = h.entity;
    if (e.owner !== selfSeat) return;
    const hand = e.getComponent(HandComponent);
    if (hand?.state.isMainHand) mainHand = e;
  });
  if (!mainHand) return null;
  const zone = (mainHand as Entity).getComponent(ZoneComponent);
  if (!zone) return null;

  const cards: CardTile[] = [];
  for (const id of zone.state.containedIds) {
    const cardEntity = world.get(id)?.entity;
    if (!cardEntity) continue;
    const flat = cardEntity.getComponent(FlatViewComponent);
    cards.push({
      id,
      name:       cardEntity.name,
      textureRef: flat?.state.textureRef ?? '',
    });
  }
  return { handEntityId: (mainHand as Entity).id, cards };
}

function handViewKey(view: HandView | null): string {
  if (!view) return '';
  return view.handEntityId + '|' + view.cards.map(c => c.id + ':' + c.textureRef).join(',');
}

// Resolve the per-seat display name array (length 8) from the room snapshot.
// Empty string means the seat is vacant; SeatOverlay skips its name plane.
// Mirrors the PlayersPanel fallback of names[peerId] ?? peerId.slice(0, 8).
function resolveSeatNames(snap: RoomStateSnapshot | null): string[] {
  const out: string[] = ['', '', '', '', '', '', '', ''];
  if (!snap) return out;
  for (const entry of snap.seats) {
    if (!entry.peerId) continue;
    out[entry.index] = snap.names?.[entry.peerId] ?? entry.peerId.slice(0, 8);
  }
  return out;
}

// Public interfaces for the World module — issue #1 of issues--arch.md.
//
// `World` consolidates entity lifecycle, replication, and the query surface
// for the renderer / editor. `WorldTransport` is the single seam between the
// World and the wire (production WebRTC vs in-memory test pair). The full
// implementation lands incrementally — issue #1 ships interfaces + a facade
// that wraps the existing Scene / HostReplicatorV2 / GuestReceiver so future
// slices can migrate call sites one at a time.

import * as THREE from 'three';
import { type Entity } from '../Entity';
import { type EntityComponent, type ComponentClass } from '../EntityComponent';
import { type EntitySerialized, type TableBounds } from '../Scene';
import { type SceneMessage, type ToolBroadcast, type PlaySoundMessage } from '../wire';
import { type SeatIndex } from '../../seats/SeatLayout';
import { type PhysicsWorld } from '../../physics/PhysicsWorld';
import { type GuestInputMessage } from '../../net/SceneState';
import { type SceneHistoryService } from '../SceneHistoryService';
import { type ScriptHost } from '../../scripting/ScriptHost';
import { type InputEventName, type InputEventPayload } from '../../input/inputEvents';

// Inbound from the wire: scene-level replication plus guest input streams.
export type WorldInboundMessage = SceneMessage | GuestInputMessage;

// Outbound from the World: host emits SceneMessages (replication); guest emits
// GuestInputMessages (drag move) and SceneMessages (hold-claim / hold-release).
export type WorldOutboundMessage = SceneMessage | GuestInputMessage;

export interface ReplicationTarget {
  peerId:   string;
  peerSeat: SeatIndex | null;
  isHost:   boolean;
}

export interface SpawnOptions {
  id?:       string;
  position?: [number, number, number];
}

// Symmetric host/guest facade over an Entity. The mutation verbs route
// internally — host writes the body / HoldService directly, guest sends the
// equivalent RPC and applies an optimistic local update where applicable.
export interface EntityHandle {
  readonly id:     string;
  readonly entity: Entity;

  position(): THREE.Vector3;
  velocity(): THREE.Vector3;
  heldBy(): SeatIndex | null;

  get<T extends EntityComponent<any>>(cls: ComponentClass<T>): T | undefined;

  // Authoritative move on host (writes the physics body); optimistic transform
  // update + `guest-drag-move` RPC on guest. Used by DragController during
  // pointer-driven carry.
  setPosition(x: number, y: number, z: number): void;

  // Ownership policy gate for starting a drag — wraps canManipulate against
  // the World's identity. Independent of `heldBy` (callers also check that).
  canStartDrag(): boolean;

  // Hold-claim attempt. Returns true if the local check passes (entity is
  // free + ownership allows). Host completes the claim synchronously; guest
  // dispatches a `hold-claim` RPC and the caller polls `heldBy()` for the
  // host's echo.
  tryHold(seat: SeatIndex): boolean;

  // Drop the hold. Host runs HoldService.release locally. Guest dispatches a
  // `hold-release` RPC. Velocity is the end-of-drag throw, optional.
  release(velocity?: { vx: number; vy: number; vz: number }): void;

  // One-shot impulse on the entity's PhysicsComponent — issue #5a of
  // issues--tools.md. Both paths gate on canManipulate + !isLocked. Host
  // applies directly; guest dispatches `apply-impulse` RPC and the host
  // validates again on receipt.
  applyImpulse(v: { x: number; y: number; z: number }): void;
}

export interface World {
  // Lifecycle (host).
  spawn(type: string, opts?: SpawnOptions): EntityHandle;
  despawn(id: string): void;

  // Entity-level field write (name, tags, owner). Issue #1 of
  // issues--property-schema-refactor.md. Replicates via entity-patch.
  updateEntityField(id: string, key: string, value: unknown): void;

  // Component-state field write. The dispatcher pre-clamps via the schema's
  // min/max, invokes the entry's adapter `set` if present, then calls the
  // component's `setState`. Issue #1 of issues--property-schema-refactor.md.
  updateComponentProp(id: string, typeId: string, key: string, value: unknown): void;

  // Host-only — spawn a child surface entity (prim:plane + SurfaceComponent)
  // on the given parent. Backs the Mesh component's "Add Surface" editor-panel
  // tool. Defaults to the parent's +Y face sized to its mesh footprint.
  attachSurface(parentId: string, opts?: import('../components/attachSticker').SurfaceChildOpts): string | null;

  // Host-only — attach a fresh SnapPointsComponent (one default point) to an
  // existing entity. Backs the Mesh component's "Add Snap Markers" editor-
  // panel tool. No-op when the entity is unknown or already carries the
  // component.
  attachSnapPoints(entityId: string): void;

  // Host-only — append one element (Rich / Image / Shape) to a surface's
  // `state.elements` array. Backs the Surface component's editor-panel
  // "Add … Element" buttons. Returns the new element id.
  attachElement(surfaceId: string, kind: import('../components/SurfaceElement').EditorElementKind): string | null;

  // Host-only — patch one element of a surface (bounds, kind-specific
  // fields). Backs the editor-panel per-element rows.
  mutateSurfaceElement(surfaceId: string, elementId: string, patch: Record<string, unknown>): void;

  // Host-only — drop one element from a surface. Backs the editor-panel's
  // per-element delete button.
  removeSurfaceElement(surfaceId: string, elementId: string): void;

  // Per-frame driver. Host: physics step, bounds, syncFromPhysics, replicator
  // flush. Guest: no-op (inbound state arrives via transport.onMessage).
  tick(dtSeconds: number): void;

  // Read surface.
  get(id: string): EntityHandle | undefined;
  all(): EntityHandle[];
  pickByObject3D(obj: THREE.Object3D): EntityHandle | undefined;
  forEach(fn: (h: EntityHandle) => void): void;

  // Singleton Table accessor + world-space half-extents helper. The Table is
  // a regular entity (carries TransformComponent + MeshComponent + a marker
  // TableComponent) but consumers needing its play-surface bounds (PingTool
  // bounds-check, World on-table rest detection, SeatLayout) read through
  // these helpers so the Table mesh / scale can change without touching them.
  getTable(): EntityHandle | undefined;
  getTableBounds(): TableBounds;

  // Coalesced subscription — fires once per state-affecting tick, not per patch.
  subscribe(fn: () => void): () => void;

  // Force a subscriber notification. Used by paths that mutate state via
  // `comp.setState` (e.g. editor-tool onAction handlers) where the World
  // doesn't otherwise know to refresh the panel.
  requestRefresh(): void;

  // Late-join + save/load.
  snapshot(): EntitySerialized[];
  loadSnapshot(snaps: readonly EntitySerialized[]): void;

  // Atomic scene replace (PRD § Save / Load). Cancels all holds, cascade-
  // despawns every entity through the existing despawn path, then loads
  // `snaps` via the two-pass construction. Host emits `scene-replace` to
  // guests; guests perform the same cascade-despawn-then-load on receipt.
  // UI state (camera, selection, current tool) is not touched.
  replaceScene(snaps: readonly EntitySerialized[]): void;

  // Host-only history surface (PRD § Save / Load — issue #4 onwards). Null on
  // guests, where Save / Load / Revert / History are not exposed.
  history: SceneHistoryService | null;

  // Host-only scripting surface (issues--scripting-v1.md). Null on guests.
  scripting: ScriptHost | null;

  // Transitional surface — `releasePeer` stays until input dispatch is fully
  // owned by World. Late-join (formerly `replayTo`) is now driven internally
  // by transport.onPeerJoin (issue #8).
  releasePeer(peerId: string): void;

  // Cosmetic broadcast from a Tool — issue #4 of issues--tools.md. Routes on
  // the unreliable channel; fires local subscribers immediately so the sender
  // sees their own ping. On host inbound, relays to other peers.
  broadcastToolMessage(toolId: string, payload: unknown): void;
  onToolBroadcast(handler: (msg: ToolBroadcast) => void): () => void;

  // Dual-fire entry point for entity-input events (issue #4 of
  // issues--interaction.md). Local-bus dispatch first so components and
  // scripts on the originating peer react instantly; on guests, also emits a
  // `guest-input-event` RPC so the host re-fires on its bus and host-only
  // scripts observe every peer's input.
  fireInputEvent(entity: Entity, eventName: InputEventName, payload: InputEventPayload): void;

  // Cosmetic sound broadcast from a host script (`scene.playSound`) — issue
  // #11 of issues--asset-registry.md. Host fires local listeners and relays
  // on the unreliable channel; guests receive `play-sound` and route into
  // their local listeners so SoundPlayer plays in sync. Subscribers play
  // through their own AssetService cache.
  broadcastPlaySound(slug: string): void;
  onPlaySound(handler: (msg: PlaySoundMessage) => void): () => void;

  // Drag-from-hand-panel-onto-canvas (issue #5 of issues--hand.md). Host runs
  // the tween directly; guest dispatches `play-card-to-table` and the host
  // validates the request originates from the hand's owner before applying.
  playCardToTable(entity: Entity, position: [number, number, number]): void;

  // Drag-within-panel reorder (issue #6 of issues--hand.md). `newOrder` must
  // be a permutation of the hand's current `containedIds`. Host applies via
  // HandComponent.reorderContents; guest dispatches `reorder-hand` for the
  // host to validate and apply.
  reorderHand(handEntityId: string, newOrder: readonly string[]): void;

  // Drag-from-3D-canvas onto a hand panel (issue #7 of issues--hand.md). Host
  // tweens the entity to the destination hand's centre; guest dispatches
  // `tween-into-hand` for the host to validate and apply. Caller should have
  // already released any active hold on the entity before invoking.
  tweenIntoHand(entity: Entity, handEntityId: string): void;

  // Pop the top `count` cards off a deck and tween each into the calling
  // seat's main hand. Issue #6 of issues--deck.md. Host runs the draw
  // directly; guest dispatches `draw-from-deck` for the host to validate.
  drawFromDeck(deckId: string, count: number, callerSeat: SeatIndex | null): void;

  // Fisher-Yates the deck's `cards` and play a brief rotation jitter tween.
  // Issue #7 of issues--deck.md.
  shuffleDeck(deckId: string, callerSeat: SeatIndex | null): void;

  // Round-robin `count` cards from a deck to every seat with a main hand,
  // ordered clockwise from the caller (caller first). Issue #9 of issues--deck.md.
  dealFromDeck(deckId: string, count: number, callerSeat: SeatIndex | null): void;

  // Release every card in the deck along its local +X axis (top card on the
  // left), then despawn the deck.
  spreadDeck(deckId: string, callerSeat: SeatIndex | null): void;

  // Short-press peel on a deck — atomically pop the top card, release it
  // from the deck, hold it for the calling seat. Host runs the sequence
  // synchronously through DeckService.peelTop; guest dispatches the
  // `peel-and-hold` RPC and the returned promise resolves when the host's
  // `peel-and-hold-reply` arrives. Resolves to null if the deck is unknown,
  // empty, locked-owner by another seat, or the host otherwise rejects.
  // Issue #2 of issues--deck-peel.md.
  peelAndHold(deckId: string, seat: SeatIndex): Promise<import('../wire').PeelAndHoldResult | null>;

  // Open Inspect on a deck (planning/issues--deck-inspect.md, issue #3). Host
  // runs DeckService.openInspect synchronously; guest dispatches the
  // `open-search` RPC and the promise resolves when the host replies.
  // Resolves to:
  //   - `{ snapshot, lockedBy: seat }` on success
  //   - `{ snapshot: null, lockedBy: <other seat> }` if another peer holds the
  //     lock — caller dismisses the dialog silently
  //   - `null` when the request was refused for any other reason (unknown
  //     deck, ownership refused, etc.)
  openInspect(deckId: string, seat: SeatIndex): Promise<{
    snapshot: Record<string, { face: string; back: string }> | null;
    lockedBy: SeatIndex | null;
  } | null>;

  // Close Inspect on a deck.
  closeInspect(deckId: string, seat: SeatIndex): void;

  // Reorder a locked deck from inside the Inspect dialog. Issue #4 of
  // planning/issues--deck-inspect.md. `newOrder` must be a permutation of
  // the deck's current `cards`; host validates the sender is the lock holder
  // before applying.
  reorderDeck(deckId: string, newOrder: readonly string[], seat: SeatIndex): void;

  // Host-only — spawn one card per face-ref and immediately wrap them in a
  // fresh Deck entity (cards become children with isContained=true, so no
  // scatter). Backs the host "Generate Deck" tool. Returns a handle to the
  // new deck, or null if the request can't be honoured.
  generateDeck(opts: GenerateDeckOptions): EntityHandle | null;

  dispose(): void;
}

export interface GenerateDeckOptions {
  faceRefs: readonly string[];
  backRef:  string;
  category: string;
  // Optional tag applied to the deck and every child card.
  tag?:     string;
  // Optional spawn position; defaults to the same scatter formula as `spawn`.
  position?: [number, number, number];
}

// Single seam for the wire. Production: RtcTransport over ConnectionManager.
// Tests: createInMemoryBusPair() — see InMemoryTransport.ts.
export interface WorldTransport {
  send(msg: WorldOutboundMessage, opts: { reliable: boolean }): void;
  sendTo?(peerId: string, msg: SceneMessage): void;
  onMessage(handler: (peerId: string, msg: WorldInboundMessage) => void): () => void;
  onPeerJoin(handler: (peerId: string) => void): () => void;
}

// Network-tuning knobs. Issue #1 defines the shape; issue #10 implements
// coalescing + flush cadence + channel routing through this object.
export interface ReplicationPolicy {
  channelFor(typeId: string): 'reliable' | 'unreliable';
  coalesceFor(typeId: string): 'merge' | 'replace' | 'last-write-wins';
  shouldFlush(typeId: string, ctx: { tick: number; nowMs: number }): boolean;
}

export interface WorldIdentity {
  isHost:      boolean;
  selfSeat():  SeatIndex | null;
  selfPeerId(): string | null;
}

// React-facing alias for `World`. Engine code keeps importing `World`; the
// alias names the same object as a controller for panels that mutate scene
// state. See planning/refactor-world-ref.md.
export type SceneController = World;

// Bundle exposed by ThreeCanvas to React. `controller` is the live World;
// `captureThumbnail` and `playCardToTableAtScreen` close over the renderer
// (WebGLRenderer + scene + camera + canvas DOM) and live on the handle so
// they don't leak WebGL into the engine.
export interface SceneHandle {
  readonly controller: SceneController;
  // Returns a PNG data URL for the current canvas, or null. Used by the host
  // save flow to embed a thumbnail in the save envelope.
  captureThumbnail(): string | null;
  // Screen-coord wrapper around `controller.playCardToTable` — needs camera +
  // canvas raycast to project the pointer onto the table plane. HandPanel
  // (via Room) calls this when a tile is dragged out of the panel.
  playCardToTableAtScreen(entityId: string, clientX: number, clientY: number): void;
}

export interface WorldOptions {
  role:      'host' | 'guest';
  scene:     THREE.Scene;
  identity:  WorldIdentity;
  transport: WorldTransport;
  // Host auto-creates a PhysicsWorld if omitted. Guests pass nothing.
  physics?:  PhysicsWorld;
  // Layered over defaults — sane defaults preserve current behaviour.
  policy?:   Partial<ReplicationPolicy>;
  // Required on the host for HostInputDispatcher's ownership checks; resolves
  // a peer id to its current seat. Returns null for spectators.
  getPeerSeat?: (peerId: string) => SeatIndex | null;
  // Host-only: returns a PNG data URL for the current canvas, or null.
  // Forwarded to SceneHistoryService for undo-entry thumbnails.
  captureThumb?: () => string | null;
  // Host-only: undo ring cap. Defaults to 20 inside SceneHistoryService.
  historyCap?: number;
}

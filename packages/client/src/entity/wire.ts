// Wire shapes for the v2 entity-component replicator.
// Slice #2 of planning/issues/issues--scene-graph.md.
//
// `ComponentPatch` is a record (no `type:`) — bundled into a
// `component-patches` envelope by the replicator. Everything else is a
// self-contained discriminated message.

import { type SeatIndex } from '../seats/SeatLayout';
import { type ReplicationChannel } from './EntityComponent';
import { type EntitySerialized } from './Scene';
import { type AssetEntry } from '../assets/Manifest';

export type { EntitySerialized };

// Entity-level fields that may appear in an EntityPatch.
export type EntityFieldsPartial = Partial<{
  name:          string;
  tags:          string[];
  owner:         SeatIndex | null;
  privateToSeat: SeatIndex | null;
  parentId:      string | null;
  children:      string[];
  isContained:   boolean;
  // Full-map snapshot — guests overwrite their `Entity.customData` with this
  // record on each patch (issue #6 of issues--scripting-v1.md). Per-key
  // delta is deferred.
  customData:    Record<string, string>;
}>;

// Per-component patch — payload inside a `component-patches` envelope.
export interface ComponentPatch {
  entityId: string;
  typeId:   string;
  partial:  Record<string, unknown>;
}

// Per-channel batched envelope for ComponentPatches.
export interface ComponentPatchesMessage {
  type:    'component-patches';
  channel: ReplicationChannel;
  patches: ComponentPatch[];
}

export interface EntityPatch {
  type:     'entity-patch';
  entityId: string;
  partial:  EntityFieldsPartial;
}

// Per-entity spawn — carries the full EntitySerialized snapshot so the guest
// can construct the entity locally. Always reliable.
export interface EntitySpawn {
  type:   'entity-spawn';
  entity: EntitySerialized;
}

// Attaches a fresh component to an already-spawned entity (e.g. host clicks
// "Add Snap Markers" on a card). Guests look up the component class in the
// registry, fromJSON `state`, attach, and onSpawn. Idempotent — guests skip
// when the entity already has the typeId. Always reliable.
export interface AttachComponent {
  type:     'attach-component';
  entityId: string;
  typeId:   string;
  state:    object;
}

// Late-join payload (issue #8 of issues--arch.md) — host's complete scene
// shipped to a freshly-connected guest in one envelope. Guests apply via
// SceneImpl.load so two-phase construction (all entities materialised before
// any onSpawn fires) keeps cross-entity GUID refs resolvable. Always reliable.
export interface SceneSnapshot {
  type:     'scene-snapshot';
  entities: EntitySerialized[];
}

// Atomic scene replace (PRD § Save / Load). Distinct from `scene-snapshot`,
// which is idempotent and intended for late-join. Guests cascade-despawn
// every existing entity and then load `entities`. Always reliable.
export interface SceneReplace {
  type:     'scene-replace';
  entities: EntitySerialized[];
}

// Reverse-tree order of entity ids to delete. Always reliable.
export interface DespawnBatch {
  type:      'despawn-batch';
  entityIds: string[];
}

export interface InvokeAction {
  type:            'invoke-action';
  entityId:        string;
  componentTypeId: string;
  actionId:        string;
}

export interface HoldClaim {
  type:     'hold-claim';
  entityId: string;
  seat:     SeatIndex;
}

export interface HoldRelease {
  type:     'hold-release';
  entityId: string;
  // End-of-drag velocity (PRD § Drag rewrite — slice #5). Optional because
  // some releases drop the body where it sits (peer disconnect, axis drag,
  // pending-claim timeout) without imparting motion.
  vx?:      number;
  vy?:      number;
  vz?:      number;
}

// Atomic pop-top-of-deck + hold for the requesting seat (planning/prd--deck-peel.md).
// Guest sends; host validates ownership, pops the top card, releases it from
// the deck, claims a hold for the sender, runs maybeDissolve, and replies with
// the new card id and the deck's pose. Reliable channel.
export interface PeelAndHoldResult {
  cardId: string;
  pos:    [number, number, number];
  rot:    [number, number, number, number];
}

export interface PeelAndHoldRequest {
  type:      'peel-and-hold';
  requestId: string;
  deckId:    string;
}

export interface PeelAndHoldReply {
  type:      'peel-and-hold-reply';
  requestId: string;
  // null on rejection (deck missing, no DeckComponent, empty, ownership refused).
  result:    PeelAndHoldResult | null;
}

export interface RequestUpdate {
  type:     'request-update';
  entityId: string;
  typeId:   string;
  partial:  Record<string, unknown>;
}

// Apply a one-shot impulse to an entity's physics body — issue #5a of
// issues--tools.md. Reliable channel (single-shot, not coalesced). Host
// validates `canManipulate` + `!isLocked` before applying.
export interface ApplyImpulse {
  type:     'apply-impulse';
  entityId: string;
  vx:       number;
  vy:       number;
  vz:       number;
}

// Drag-from-hand-panel-onto-canvas (issue #5 of issues--hand.md). Reliable
// channel (single-shot). Host validates that the request originates from the
// hand's owner (or anyone for a null-owner shared hand) before tweening.
export interface PlayCardToTable {
  type:     'play-card-to-table';
  entityId: string;
  x:        number;
  y:        number;
  z:        number;
}

// Drag-within-hand-panel reorder (issue #6 of issues--hand.md). `newOrder`
// must be a permutation of the hand's current `containedIds`. Host validates
// owner-match and permutation membership before applying.
export interface ReorderHand {
  type:         'reorder-hand';
  handEntityId: string;
  newOrder:     string[];
}

// Drag-from-3D-canvas onto a hand panel (issue #7 of issues--hand.md). After
// GrabTool releases the hold, host tweens the entity to the hand's centre so
// the zone-enter logic slots it normally. Host validates that the requesting
// seat owns the destination hand (or it's a null-owner shared hand).
export interface TweenIntoHand {
  type:         'tween-into-hand';
  entityId:     string;
  handEntityId: string;
}

// Right-click "Draw N" on a deck. Issue #6 of issues--deck.md. Reliable
// channel (single-shot). Host validates `canManipulate(deck.owner)` and that
// the caller has a main hand, then pops `min(count, cards.length)` cards from
// the front and tweens each into the caller's main hand.
export interface DrawFromDeck {
  type:   'draw-from-deck';
  deckId: string;
  count:  number;
}

// Right-click "Shuffle" on a deck. Issue #7 of issues--deck.md. Reliable
// channel. Host validates `canManipulate(deck.owner)`, runs Fisher-Yates on
// the deck's `cards`, and plays a 200ms rotation jitter tween for feedback.
export interface ShuffleDeck {
  type:   'shuffle-deck';
  deckId: string;
}

// Right-click "Deal N" on a deck. Issue #9 of issues--deck.md. Reliable
// channel. Host validates `canManipulate(deck.owner)`, builds the recipient
// list (seats with a main hand, ordered clockwise from the caller, caller
// first), and runs `count` rounds of round-robin deals.
export interface DealFromDeck {
  type:   'deal-from-deck';
  deckId: string;
  count:  number;
}

// Right-click "Spread deck" — release every card in deck order along the
// deck's local +X axis, then despawn the now-empty deck. Reliable channel;
// host validates `canManipulate(deck.owner)` before running.
export interface SpreadDeck {
  type:   'spread-deck';
  deckId: string;
}

// Short-press peel on a deck — issue #2 of issues--deck-peel.md. Guest sends
// the request; host atomically pops the top card, releases it from the deck,
// holds it for the requesting seat, and replies with the new card's id +
// pose (or null on rejection). Correlated by `requestId` so the guest can
// match the reply back to the pending GrabTool gesture.
export interface PeelAndHoldRequest {
  type:      'peel-and-hold';
  requestId: string;
  deckId:    string;
}

export interface PeelAndHoldResult {
  cardId: string;
  pos:    [number, number, number];
  rot:    [number, number, number, number];
}

export interface PeelAndHoldReply {
  type:      'peel-and-hold-reply';
  requestId: string;
  result:    PeelAndHoldResult | null;
}

// Cosmetic sound effect broadcast initiated from a host script via
// `scene.playSound(slug)`. Issue #11 of issues--asset-registry.md. Rides the
// unreliable channel — missed messages are not retried (audio cues are
// stale-fast). Every peer (including the host) resolves the slug through its
// own AssetService and plays the buffer locally; the host echoes through its
// `onPlaySound` subscribers so its local SoundPlayer sees the same event.
export interface PlaySoundMessage {
  type: 'play-sound';
  slug: string;
}

// Cosmetic broadcast originated by a Tool (issue #3 of issues--tools.md).
// Rides the unreliable channel — missed messages are not retried. Payload
// schema is per-tool (e.g. ping carries `{ entityId }` or `{ point: [x,z] }`).
// PingTool is the first consumer in the next slice; this slice only lays the
// wire surface.
export interface ToolBroadcast {
  type:    'tool-broadcast';
  toolId:  string;
  peerId:  string;
  seat:    SeatIndex | null;
  payload: unknown;
}

// Drag-extract from the Inspect dialog (issue #5 of
// planning/issues--deck-inspect.md). Guest dispatches with the world-space
// hit point of the cursor on the table plane; host validates lock holder +
// cardId ∈ deck.cards + hit point on a valid table surface, pops the card,
// releases it from the deck, and sets its pose face-up at the hit point.
export interface ExtractFromDeck {
  type:   'extract-from-deck';
  deckId: string;
  cardId: string;
  x:      number;
  y:      number;
  z:      number;
}

// Drag-reorder within the Inspect dialog (issue #4 of
// planning/issues--deck-inspect.md). `newOrder` must be a permutation of the
// deck's current `cards`. Host validates that the sender is the lock holder
// before applying.
export interface ReorderDeck {
  type:     'reorder-deck';
  deckId:   string;
  newOrder: string[];
}

// Open Inspect on a deck (issue #3 of planning/issues--deck-inspect.md). Guest
// sends; host validates lock-free, sets `searchLockedBy = seat`, and returns a
// snapshot of every card's face/back textures so the dialog can render
// thumbnails for cards that are otherwise privacy-scrubbed inside the deck.
// Correlated by `requestId` so the guest can match the reply back to its
// pending dialog open.
export interface OpenSearchRequest {
  type:      'open-search';
  requestId: string;
  deckId:    string;
}

export interface OpenSearchReply {
  type:      'open-search-reply';
  requestId: string;
  // Present on success.
  snapshot?: Record<string, { face: string; back: string }>;
  deckId:    string;
  // Present on rejection — names the seat currently holding the lock so the
  // requester can show "🔍 <name>" instead of opening the dialog.
  lockedBy?: SeatIndex;
}

export interface CloseSearch {
  type:   'close-search';
  deckId: string;
}

// Custom asset manifest snapshot. Issue #5 of issues--asset-registry.md. Host
// broadcasts on manager Push and on peer-join (when the snapshot is
// non-empty). Guests apply via `ManifestStore.applyPublishedSnapshot`, which
// updates both draft and published. Routed at the room layer (alongside
// room-state etc.) rather than through the World's per-entity replicator —
// asset metadata is global, not per-entity, and the room channel already has
// the host/guest fanout it needs.
export interface ManifestPublishMessage {
  type:     'manifest-publish';
  snapshot: AssetEntry[];
}

// Discriminated union of every wire message that flows over a scene channel.
export type SceneMessage =
  | ComponentPatchesMessage
  | EntitySpawn
  | AttachComponent
  | SceneSnapshot
  | SceneReplace
  | EntityPatch
  | DespawnBatch
  | InvokeAction
  | HoldClaim
  | HoldRelease
  | RequestUpdate
  | ApplyImpulse
  | PlayCardToTable
  | ReorderHand
  | TweenIntoHand
  | DrawFromDeck
  | ShuffleDeck
  | DealFromDeck
  | SpreadDeck
  | PeelAndHoldRequest
  | PeelAndHoldReply
  | OpenSearchRequest
  | OpenSearchReply
  | CloseSearch
  | ReorderDeck
  | ExtractFromDeck
  | ToolBroadcast
  | PlaySoundMessage;

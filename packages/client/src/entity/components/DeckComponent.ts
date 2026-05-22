// Deck of cards. Issue #2 of issues--deck.md.
//
// Owns `cards: string[]` (card entity IDs, top to bottom; index 0 is the
// visible top) and `category: string`. On `cards` change, patches the sibling
// MeshComponent.size (height = 0.02 × cards.length) and pushes the top card's
// face / bottom card's back into the mesh's `face` / `back` material slots.
// Also re-derives the sibling PhysicsComponent's mass and rebuilds its shape
// to match the new height.

import * as THREE from 'three';
import {
  EntityComponent,
  type SpawnContext,
  type MenuItem,
  type ActionContext,
  type GrabIntent,
} from '../EntityComponent';
import { type SeatIndex } from '../../seats/SeatLayout';
import { MeshComponent } from './MeshComponent';
import { PhysicsComponent } from './PhysicsComponent';
import { CardComponent } from './CardComponent';
import { HandComponent } from './HandComponent';

// Subtle emissive glow applied to the deck's mesh while another peer holds
// the Inspect lock. Issue #3 of planning/issues--deck-inspect.md. Indigo so
// it reads as "in use by someone else" against the white deck side.
const LOCK_GLOW_COLOR = 0x4060d0;

export interface DeckState {
  cards:    string[];
  category: string;
  // When true, the deck's top renders the top card's face (and the bottom
  // renders the bottom card's back). Default false → top renders the top
  // card's back (face-down deck) and the bottom renders the bottom card's
  // face. Toggled via the deck's "Show top card face" / "Hide top card face"
  // context-menu action.
  showTopFace: boolean;
  // Transient inspect-lock (planning/issues--deck-inspect.md). Non-null while
  // a peer holds the Inspect dialog open; gates draw / shuffle / deal /
  // spread / peel / merge for every other seat. Stripped at save time alongside
  // `Entity.heldBy`.
  searchLockedBy: SeatIndex | null;
}

// Per-card slab thickness used to grow the deck height. Twice the card
// thickness (cards have y-size 0.01) so each slab visibly stripes.
export const CARD_SLAB_HEIGHT = 0.02;
// Per-card mass. Mirrors the `card` spawnable's physics.mass. Inlined here to
// keep DeckComponent independent of the spawnable registry.
export const CARD_MASS = 0.05;
// Visible height ceiling for the deck mesh — past this point extra cards
// keep stacking logically but the mesh stops growing so very tall decks
// don't poke through the camera / table-zone roof. Sized to ~30 cards.
export const MAX_DECK_HEIGHT = 30 * CARD_SLAB_HEIGHT;

export class DeckComponent extends EntityComponent<DeckState> {
  static typeId   = 'deck';
  static requires = ['transform', 'mesh', 'physics'] as const;

  onSpawn(_ctx: SpawnContext): void {
    this.applyCardsToSiblings();
  }

  // Strip the transient `searchLockedBy` slot on serialisation so save files
  // never carry a stale lock back across a load. Mirrors the way
  // `Entity.heldBy` is omitted from `entityToSerialized`.
  toJSON(): object {
    const { cards, category, showTopFace } = this.state;
    return { cards: [...cards], category, showTopFace };
  }

  fromJSON(o: object): void {
    const raw = o as Partial<DeckState>;
    this.state = {
      cards:          raw.cards ? [...raw.cards] : [],
      category:       raw.category ?? '',
      showTopFace:    raw.showTopFace ?? false,
      searchLockedBy: null,
    };
  }

  onPropertiesChanged(changed: Partial<DeckState>): void {
    if (changed.cards !== undefined || changed.showTopFace !== undefined) {
      this.applyCardsToSiblings();
    }
    if (changed.searchLockedBy !== undefined) {
      this.applyLockGlow();
    }
  }

  // Short-press-and-drag on a deck peels the top card; long-press carries the
  // whole deck. Empty deck falls through to whole-deck grab so the gesture is
  // never a dead-end. Issue #2 of issues--deck-peel.md. While the deck is
  // search-locked by another seat, both gestures are refused.
  onTryGrab(isLongPress: boolean): GrabIntent | null {
    // Locked decks are not grabbable by anyone but the lock holder. The grab
    // gesture has no seat context at this layer, so we conservatively refuse
    // whenever a lock is set; the lock holder uses the dialog instead.
    if (this.state.searchLockedBy !== null) return null;
    if (isLongPress)                    return null;
    if (this.state.cards.length === 0)  return null;
    return { kind: 'peel', sourceId: this.entity.id };
  }

  // Deck items use submenus and args (draw/deal counts), so they don't fit
  // the pure-action shape and live on the menu-controls track. The
  // `draw-from-deck` / `shuffle-deck` / `deal-from-deck` / `spread-deck`
  // RPCs short-circuit in `dispatchMenuAction` before reaching `onAction`.
  getMenuControls(ctx: ActionContext): MenuItem[] {
    const handId = ctx.recipientSeat !== null
      ? findMainHandId(this.entity.scene, ctx.recipientSeat)
      : null;
    const drawMenu: MenuItem = handId === null
      ? { kind: 'action', id: 'draw', label: 'Draw', disabled: true }
      : {
          kind:  'submenu',
          label: 'Draw',
          items: [
            { kind: 'action',  id: 'draw', label: '1',      args: { count: 1 } },
            { kind: 'action',  id: 'draw', label: '2',      args: { count: 2 } },
            { kind: 'action',  id: 'draw', label: '3',      args: { count: 3 } },
            { kind: 'action',  id: 'draw', label: '5',      args: { count: 5 } },
            { kind: 'numeric', id: 'draw', label: 'Other…', min: 1, default: 1 },
          ],
        };
    const dealMenu: MenuItem = {
      kind:  'submenu',
      label: 'Deal',
      items: [
        { kind: 'action',  id: 'deal', label: '1',      args: { count: 1 } },
        { kind: 'action',  id: 'deal', label: '2',      args: { count: 2 } },
        { kind: 'action',  id: 'deal', label: '3',      args: { count: 3 } },
        { kind: 'action',  id: 'deal', label: '5',      args: { count: 5 } },
        { kind: 'numeric', id: 'deal', label: 'Other…', min: 1, default: 1 },
      ],
    };
    // Inspect (planning/issues--deck-inspect.md). Disabled with the holder's
    // seat shown when another peer is currently inspecting; the lock holder
    // sees the entry enabled (clicking it is a no-op, but tests may rely on
    // the menu item being present and enabled for the holder).
    const lockedBy = this.state.searchLockedBy;
    const lockedByOther = lockedBy !== null && lockedBy !== ctx.recipientSeat;
    const inspectMenu: MenuItem = lockedByOther
      ? { kind: 'action', id: 'inspect', label: `Inspect — seat ${lockedBy}`, disabled: true }
      : { kind: 'action', id: 'inspect', label: 'Inspect' };
    const toggleFace: MenuItem = {
      kind:  'action',
      id:    'toggle-top-face',
      label: this.state.showTopFace ? 'Hide top card face' : 'Show top card face',
    };
    return [
      drawMenu,
      { kind: 'action', id: 'shuffle', label: 'Shuffle' },
      inspectMenu,
      dealMenu,
      { kind: 'action', id: 'spread', label: 'Spread deck' },
      toggleFace,
    ];
  }

  onAction(name: string, _ctx: ActionContext): void {
    if (name === 'toggle-top-face') {
      this.setState({ showTopFace: !this.state.showTopFace });
      return;
    }
  }

  // Toggles a subtle emissive glow on the deck's side material whenever the
  // inspect-lock state changes. Visible to every peer (including the holder)
  // through standard state replication.
  private applyLockGlow(): void {
    const mesh = this.entity.getComponent(MeshComponent);
    if (!mesh) return;
    const locked = this.state.searchLockedBy !== null;
    mesh.group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) {
        const lambert = mat as THREE.MeshLambertMaterial;
        if (!lambert.emissive) continue;
        lambert.emissive.setHex(locked ? LOCK_GLOW_COLOR : 0x000000);
        (lambert as THREE.MeshLambertMaterial & { emissiveIntensity?: number }).emissiveIntensity = locked ? 0.4 : 0;
        lambert.needsUpdate = true;
      }
    });
  }

  private applyCardsToSiblings(): void {
    const mesh = this.entity.getComponent(MeshComponent);
    if (!mesh) return;
    const n = this.state.cards.length;
    if (n === 0) return;

    const w = mesh.state.width;
    const d = mesh.state.depth;
    // Logical card count grows unbounded (cards-as-array), but the visible
    // mesh height caps at MAX_DECK_HEIGHT so very tall stacks don't poke
    // through the table-zone roof.
    const h = Math.min(CARD_SLAB_HEIGHT * n, MAX_DECK_HEIGHT);

    const topId    = this.state.cards[0];
    const bottomId = this.state.cards[n - 1];
    const topCard    = this.entity.scene?.getEntity(topId)?.getComponent(CardComponent);
    const bottomCard = this.entity.scene?.getEntity(bottomId)?.getComponent(CardComponent);

    // Mesh slot `face` = +Y (visible top of the deck); `back` = -Y (bottom).
    // When face-down (default), the top card sits face-down on the stack so
    // its `back` shows on top; the bottom card's `face` shows underneath.
    // Flipping `showTopFace` mirrors both ends.
    const topFace = topCard?.state.face ?? '';
    const topBack = topCard?.state.back ?? '';
    const botFace = bottomCard?.state.face ?? '';
    const botBack = bottomCard?.state.back ?? '';
    mesh.setState({
      width:  w,
      height: h,
      depth:  d,
      textureRefs: {
        ...mesh.state.textureRefs,
        face: this.state.showTopFace ? topFace : topBack,
        back: this.state.showTopFace ? botBack : botFace,
      },
    });

    const phys = this.entity.getComponent(PhysicsComponent);
    if (phys) {
      phys.rebuildShape();
      phys.setState({ mass: CARD_MASS * n });
    }
  }
}

function findMainHandId(scene: { all(): import('../Entity').Entity[] } | null, seat: number): string | null {
  if (!scene) return null;
  for (const e of scene.all()) {
    if (e.owner !== seat) continue;
    const hand = e.getComponent(HandComponent);
    if (hand?.state.isMainHand) return e.id;
  }
  return null;
}

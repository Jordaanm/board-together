import * as THREE from 'three';
import { type World } from '../entity/world';
import { TransformComponent } from '../entity/components/TransformComponent';
import { TableComponent } from '../entity/components/TableComponent';
import { aggregateContextMenu } from '../entity/contextMenu';
import { type Entity } from '../entity/Entity';
import { type MenuItem, type ActionContext } from '../entity/EntityComponent';
import { type ChannelMessage } from '../net/SceneState';
import { type SeatIndex } from '../seats/SeatLayout';
import { canManipulate } from '../seats/OwnershipPolicy';
import { load as loadPreferences } from '../preferences/storage';

export interface ContextMenuRequest {
  x:          number;
  y:          number;
  entityId:   string;
  entityName: string;
  entityTags: string[];
  items:      MenuItem[];
}

const MENU_W        = 175;
const MENU_ITEM_H   = 36;
const MENU_HEADER_H = 44;
const MENU_PADDING  = 12;

// Transitional host-only built-in. Roll has migrated onto ValueComponent;
// Delete is still pending a home (see todo.md — base class vs. editor panel).
const BUILTIN_DELETE: MenuItem = { kind: 'action', id: '__delete', label: 'Delete' };

export class ContextMenuController {
  constructor(
    private readonly element:     HTMLElement,
    private readonly camera:      THREE.PerspectiveCamera,
    private readonly isHost:      boolean,
    private readonly world:       World,
    private readonly getSelfSeat: () => SeatIndex | null,
    private readonly onOpen:      (req: ContextMenuRequest) => void,
  ) {
    element.addEventListener('contextmenu', this.onContextMenu);
  }

  dispose() {
    this.element.removeEventListener('contextmenu', this.onContextMenu);
  }

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();

    const rect = this.element.getBoundingClientRect();
    const ptr  = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width)  * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ptr, this.camera);

    const meshes: THREE.Object3D[] = [];
    this.world.forEach((h) => {
      const t = h.get(TransformComponent);
      if (t?.object3d) meshes.push(t.object3d);
    });
    const hits = ray.intersectObjects(meshes, true);
    if (!hits.length) return;

    const handle = this.world.pickByObject3D(hits[0].object);
    if (!handle) return;
    const entity = handle.entity;

    // Singleton Table is undeletable and exposes no per-component actions to
    // the user (PRD § Locking enforcement). Skip the menu entirely so a
    // right-click on the Table mesh feels like a right-click on empty space.
    if (entity.hasComponent(TableComponent)) return;

    const seat = this.getSelfSeat();
    const ctx: ActionContext = {
      recipientSeat: seat,
      isHost:        this.isHost,
      entity,
      preferences:   loadPreferences(),
    };
    const items = aggregateContextMenu(entity, ctx);

    // Append host-only built-ins (Delete always; Roll for dice).
    if (this.isHost) {
      const builtins = builtinHostActions(entity);
      if (builtins.length > 0) {
        if (items.length > 0) items.push({ kind: 'separator' });
        items.push(...builtins);
      }
    }

    if (items.length === 0) return;

    const itemCount = countLeafItems(items);
    const menuH     = MENU_HEADER_H + itemCount * MENU_ITEM_H + MENU_PADDING;

    this.onOpen({
      x:          Math.min(e.clientX, window.innerWidth  - MENU_W),
      y:          Math.min(e.clientY, window.innerHeight - menuH),
      entityId:   entity.id,
      entityName: entity.name,
      entityTags: [...entity.tags],
      items,
    });
  };
}

// Exported for unit-testing the Table-suppression rule. Production callers
// stay inside `onContextMenu` above; the export adds no surface area.
export function builtinHostActions(entity: Entity): MenuItem[] {
  // Singleton Table is undeletable (PRD § Locking enforcement). Suppress
  // the Delete entry rather than relying on the runtime guard to throw.
  if (entity.hasComponent(TableComponent)) return [];
  return [BUILTIN_DELETE];
}

function countLeafItems(items: MenuItem[]): number {
  let n = 0;
  for (const item of items) {
    if (item.kind === 'separator' || item.kind === 'heading') continue;
    n += 1;
  }
  return n;
}

// ── Click routing ──────────────────────────────────────────────────────────
// Called by the React UI when the user clicks a menu action. Encapsulates
// the host-local vs. invoke-action decision so the UI just forwards (item,
// args) into here.

export interface MenuActionDeps {
  isHost:        boolean;
  entity:        Entity | undefined;        // resolved at request time
  send:          (msg: ChannelMessage) => void;
  hostLocal: {
    delete:        (entityId: string) => void;
    drawFromDeck?: (deckId: string, count: number, callerSeat: SeatIndex | null) => void;
    shuffleDeck?:  (deckId: string, callerSeat: SeatIndex | null) => void;
    dealFromDeck?: (deckId: string, count: number, callerSeat: SeatIndex | null) => void;
    spreadDeck?:   (deckId: string, callerSeat: SeatIndex | null) => void;
  };
  selfSeat:      SeatIndex | null;
}

export function dispatchMenuAction(
  item:    MenuItem & { kind: 'action' | 'colorpicker' },
  args:    object | undefined,
  entityId: string,
  deps:    MenuActionDeps,
): void {
  // Built-in host-only action short-circuits straight to the host runtime.
  if (item.kind === 'action' && item.id === '__delete') {
    if (deps.isHost) deps.hostLocal.delete(entityId);
    return;
  }

  // Deck draw — host runs locally; guest dispatches the dedicated RPC. Issue
  // #6 of issues--deck.md.
  if (item.kind === 'action' && item.id === 'draw' && item.componentTypeId === 'deck') {
    const count = (args as { count?: number } | undefined)?.count ?? 1;
    if (deps.isHost) {
      deps.hostLocal.drawFromDeck?.(entityId, count, deps.selfSeat);
    } else {
      deps.send({ type: 'draw-from-deck', deckId: entityId, count });
    }
    return;
  }

  // Deck shuffle — issue #7 of issues--deck.md.
  if (item.kind === 'action' && item.id === 'shuffle' && item.componentTypeId === 'deck') {
    if (deps.isHost) {
      deps.hostLocal.shuffleDeck?.(entityId, deps.selfSeat);
    } else {
      deps.send({ type: 'shuffle-deck', deckId: entityId });
    }
    return;
  }

  // Deck deal — issue #9 of issues--deck.md.
  if (item.kind === 'action' && item.id === 'deal' && item.componentTypeId === 'deck') {
    const count = (args as { count?: number } | undefined)?.count ?? 1;
    if (deps.isHost) {
      deps.hostLocal.dealFromDeck?.(entityId, count, deps.selfSeat);
    } else {
      deps.send({ type: 'deal-from-deck', deckId: entityId, count });
    }
    return;
  }

  // Deck spread — release every card along the deck's local +X axis, despawn
  // the deck.
  if (item.kind === 'action' && item.id === 'spread' && item.componentTypeId === 'deck') {
    if (deps.isHost) {
      deps.hostLocal.spreadDeck?.(entityId, deps.selfSeat);
    } else {
      deps.send({ type: 'spread-deck', deckId: entityId });
    }
    return;
  }

  if (!item.componentTypeId) return; // unknown action — drop

  // Colorpicker (and any future menu-control) ships an args payload through
  // its own host-local branch, separate from the pure-action path. Hits
  // `onEditorAction` so the component's args-bearing handler runs. Guests do
  // not currently invoke menu controls — colorpicker UX is host-only — but
  // the shape is preserved for symmetry.
  if (item.kind === 'colorpicker') {
    if (deps.isHost && deps.entity) {
      if (!canManipulate({ peerSeat: deps.selfSeat, isHost: true }, deps.entity.owner)) return;
      const comp = deps.entity.components.get(item.componentTypeId);
      if (!comp) return;
      const actionCtx: ActionContext = {
        recipientSeat: deps.selfSeat, isHost: true, entity: deps.entity,
        preferences:   loadPreferences(),
      };
      comp.onEditorAction(item.id, args, actionCtx);
    }
    return;
  }

  dispatchAction(entityId, item.componentTypeId, item.id, {
    isHost:   deps.isHost,
    entity:   deps.entity,
    send:     deps.send,
    selfSeat: deps.selfSeat,
  });
}

// Host/guest routing for a pure component action. Called by both the
// context-menu dispatcher (above) and the HotkeyDispatcher (issue #3). On
// host: gates on `canManipulate`, snapshots Preferences, invokes
// `comp.onAction(name, ctx)`. On guest: emits an `invoke-action` RPC with no
// `args` field.
export interface DispatchActionDeps {
  isHost:   boolean;
  entity:   Entity | undefined;
  send:     (msg: ChannelMessage) => void;
  selfSeat: SeatIndex | null;
}

export function dispatchAction(
  entityId:        string,
  componentTypeId: string,
  actionName:      string,
  deps:            DispatchActionDeps,
): void {
  if (deps.isHost) {
    if (!deps.entity) return;
    if (!canManipulate({ peerSeat: deps.selfSeat, isHost: true }, deps.entity.owner)) return;
    const comp = deps.entity.components.get(componentTypeId);
    if (!comp) return;
    const ctx: ActionContext = {
      recipientSeat: deps.selfSeat,
      isHost:        true,
      entity:        deps.entity,
      preferences:   loadPreferences(),
    };
    comp.onAction(actionName, ctx);
    return;
  }

  deps.send({
    type: 'invoke-action',
    entityId,
    componentTypeId,
    actionId: actionName,
  });
}

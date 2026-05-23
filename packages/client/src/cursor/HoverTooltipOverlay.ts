// Local-only DOM tooltip for container hover. Renders "{count} {label}" next
// to the cursor while the local player is hovering a bag or deck. The data
// stays on the client — no world / network traffic — so each player sees
// their own tooltip and no one else's.
//
// Pairs with InputDispatcher.getHoveredId() and a pointer-position ref in
// ThreeCanvas's animation loop. The pure resolver below is exported for unit
// tests.

import { type Entity } from '../entity/Entity';
import { BagComponent } from '../entity/components/BagComponent';
import { DeckComponent } from '../entity/components/DeckComponent';

export interface ContainerTooltipInfo {
  count: number;
  label: string;
}

// Returns the count+label pair for a bag/deck entity, or null when the entity
// is not a container. Bags use `contents.length`; decks use `cards.length`.
export function resolveContainerTooltip(entity: Entity): ContainerTooltipInfo | null {
  const bag = entity.getComponent(BagComponent);
  if (bag) return { count: bag.state.contents.length, label: bag.state.label };
  const deck = entity.getComponent(DeckComponent);
  if (deck) return { count: deck.state.cards.length, label: deck.state.label };
  return null;
}

export class HoverTooltipOverlay {
  private readonly el: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'hover-tooltip';
    Object.assign(this.el.style, {
      position:      'fixed',
      pointerEvents: 'none',
      background:    'rgba(20, 20, 28, 0.9)',
      color:         '#fff',
      padding:       '4px 8px',
      borderRadius:  '4px',
      font:          '13px sans-serif',
      whiteSpace:    'nowrap',
      zIndex:        '1000',
      display:       'none',
      transform:     'translate(12px, 12px)',
    } as Partial<CSSStyleDeclaration>);
    parent.appendChild(this.el);
  }

  update(entity: Entity | null, pointer: { x: number; y: number } | null): void {
    if (!entity || !pointer) {
      this.hide();
      return;
    }
    const info = resolveContainerTooltip(entity);
    if (!info) {
      this.hide();
      return;
    }
    const text = `${info.count} ${info.label}`;
    if (this.el.textContent !== text) this.el.textContent = text;
    this.el.style.left    = `${pointer.x}px`;
    this.el.style.top     = `${pointer.y}px`;
    if (this.el.style.display !== 'block') this.el.style.display = 'block';
  }

  hide(): void {
    if (this.el.style.display !== 'none') this.el.style.display = 'none';
  }

  dispose(): void {
    this.el.remove();
  }
}

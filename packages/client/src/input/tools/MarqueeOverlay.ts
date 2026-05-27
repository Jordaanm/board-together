// MarqueeOverlay — DOM rectangle drawn over the canvas while a marquee drag
// is in flight. Slice #2 of issues--marquee.md.
//
// Owns the lifecycle of a single absolutely-positioned <div> appended to the
// canvas container. Coordinates are screen-space (relative to the container's
// bounding rect). Inverted drags are normalised to min/max so the rect
// always renders with positive width / height.

export interface ScreenCorner {
  x: number;
  y: number;
}

export class MarqueeOverlay {
  private readonly el: HTMLDivElement;
  private attached = false;

  constructor(private readonly container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'marquee-overlay';
    Object.assign(this.el.style, {
      position:        'absolute',
      pointerEvents:   'none',
      // Translucent accent fill + solid 1px accent border. Matches the
      // existing accent token used by the rest of the UI; falls back to
      // a sensible hex if --accent is undefined in tests.
      background:      'color-mix(in oklab, var(--accent, #ffd740) 18%, transparent)',
      border:          '1px solid var(--accent, #ffd740)',
      borderRadius:    '2px',
      zIndex:          '20',
      display:         'none',
    } as Partial<CSSStyleDeclaration>);
  }

  attach(): void {
    if (this.attached) return;
    this.container.appendChild(this.el);
    this.attached = true;
  }

  // Update the rect to span between the two corners. Corner coordinates are
  // expected to be relative to the container (i.e. clientX/Y minus the
  // container's left/top). Caller handles the conversion.
  update(a: ScreenCorner, b: ScreenCorner): void {
    if (!this.attached) return;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(a.x - b.x);
    const h = Math.abs(a.y - b.y);
    this.el.style.left    = `${x}px`;
    this.el.style.top     = `${y}px`;
    this.el.style.width   = `${w}px`;
    this.el.style.height  = `${h}px`;
    if (this.el.style.display !== 'block') this.el.style.display = 'block';
  }

  detach(): void {
    if (!this.attached) return;
    this.el.remove();
    this.el.style.display = 'none';
    this.attached = false;
  }

  isAttached(): boolean { return this.attached; }
}

// Canonical editor-facing scripting API. Single source of truth for what
// user scripts can call. Two consumers:
//
//   1. The codegen at packages/client/scripts/gen-script-globals.ts walks
//      this file's exported classes and emits script-globals.dts — a text
//      artifact (deliberately *not* .d.ts to avoid TypeScript ambient
//      pollution under tsconfig include) that Monaco loads via
//      addExtraLib for autocomplete and inline diagnostics.
//
//   2. The drift test at script-globals.test.ts asserts the runtime classes
//      (Game, SceneFacade, EntityFacade) are structurally assignable to
//      the Editor* types declared here. If a contributor adds a method to
//      the runtime without updating this file, `tsc --noEmit` fails.
//
// Constraints:
//   - Use `class` (not `interface`) so the codegen can emit `declare class`
//     directly without inventing constructors. Method bodies are no-op
//     stubs; the bodies are stripped by the codegen.
//   - Names are prefixed `Editor*` so they don't collide with the runtime
//     classes when the drift test imports both.
//   - Keep the surface MINIMAL — only what scripts need to call. Internal
//     types (Entity, EntityScene, ScriptRunContext) stay private.

export interface EditorReadOnlyComponentView {
  readonly state: Readonly<Record<string, unknown>>;
}

export type EditorListener = (payload: unknown) => void;

// Mirrors the runtime SeatIndex shape (number, narrowed by host code).
export type EditorSeatIndex = number;

export type EditorAssetType = 'image' | 'model' | 'sound' | 'spritesheet';

export interface EditorAssetEntry {
  readonly slug:         string;
  readonly name:         string;
  readonly type:         EditorAssetType;
  readonly url:          string;
  readonly preload:      boolean;
  readonly description?: string;
  readonly tags?:        readonly string[];
  readonly cols?:        number;
  readonly rows?:        number;
  readonly bundled?:     boolean;
  readonly hash?:        string;
  readonly size?:        number;
}

export class EditorAssetsApi {
  get(slug: string): EditorAssetEntry | null { void slug; return null; }
  list(opts?: { type?: EditorAssetType }): ReadonlyArray<EditorAssetEntry> { void opts; return []; }
}

export type EditorShapeKind = 'rect' | 'circle';
export type EditorImageFit  = 'fit' | 'cover' | 'stretch' | 'none';

export interface EditorShapeOpts {
  shape?:       EditorShapeKind;
  fill?:        string;
  stroke?:      string;
  strokeWidth?: number;
  radius?:      number;
}

export type EditorButtonImageSlot = 'normal' | 'hovered' | 'pressed';

export interface EditorButtonImagesPatch {
  normal?:  string;
  hovered?: string;
  pressed?: string;
}

export type EditorStickerFace = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

export interface EditorStickerOpts {
  face:        EditorStickerFace;
  size?:       [number, number];
  offset?:     number;
  canvasSize?: [number, number];
  content:
    | { shape: { kind: EditorShapeKind; fill?: string; stroke?: string; strokeWidth?: number; radius?: number } }
    | { image: string; fit?: EditorImageFit }
    | { html:  string }
    | { button: { normal: string; hovered?: string; pressed?: string; fit?: EditorImageFit } };
}

// Valid event names dispatched on an entity's bus. Sourced from
// `InputEventName` (pressed/released/click/hover-*) plus per-component
// domain events (`value-changed` from ValueComponent). Keep in sync with
// the dispatchers — see docs/scripting.md "Events".
export type EditorEntityEvent =
  | 'pressed'
  | 'released'
  | 'click'
  | 'hover-start'
  | 'hover-move'
  | 'hover-end'
  | 'value-changed';

export class EditorEntityFacade {
  declare readonly id:    string;
  declare readonly type:  string;
  declare readonly name:  string;
  declare readonly owner: EditorSeatIndex | null;
  declare readonly tags:  string[];

  getComponent(typeId: string): EditorReadOnlyComponentView | undefined { void typeId; return undefined; }
  addEventListener(event: EditorEntityEvent, cb: EditorListener): void { void event; void cb; }
  removeEventListener(event: EditorEntityEvent, cb: EditorListener): void { void event; void cb; }
  setValue(value: string): void { void value; }
  setData(key: string, value: string): void { void key; void value; }
  getData(key: string): string | undefined { void key; return undefined; }
  deleteData(key: string): boolean { void key; return false; }
}

// Valid event names dispatched on a SurfaceComponent's per-element bus
// (SurfaceComponent only forwards pressed/released/click + hover-start/end
// to the element under the hit; entity-level `hover-move` and
// `value-changed` don't propagate to elements).
export type EditorElementEvent =
  | 'pressed'
  | 'released'
  | 'click'
  | 'hover-start'
  | 'hover-end';

// Handle for one element living inside a SurfaceComponent's `state.elements`
// array. Returned by `scene.attachSticker` and `scene.getElement`. Replaces
// the per-element entity facade — the element is data, not an entity.
export class EditorElementHandle {
  declare readonly surfaceId: string;
  declare readonly elementId: string;

  setBounds(x: number, y: number, w: number, h: number): void { void x; void y; void w; void h; }
  setHtml(html: string): void { void html; }
  setImageRef(ref: string): void { void ref; }
  setImageFit(fit: EditorImageFit): void { void fit; }
  setShape(opts: EditorShapeOpts): void { void opts; }
  setButtonImages(images: EditorButtonImagesPatch): void { void images; }
  setButtonImage(slot: EditorButtonImageSlot, ref: string): void { void slot; void ref; }
  setButtonFit(fit: EditorImageFit): void { void fit; }
  addEventListener(event: EditorElementEvent, cb: EditorListener): void { void event; void cb; }
  removeEventListener(event: EditorElementEvent, cb: EditorListener): void { void event; void cb; }
}

export type EditorEndedBy = 'player' | 'host' | 'script';

// Editor-facing turn-tracker surface mounted at `scene.turns`. Mirrors the
// runtime TurnsApi. See planning/prd--turn-order.md.
export class EditorTurnsApi {
  enable(order?: EditorSeatIndex[]): void { void order; }
  disable(): void {}
  next(): void {}
  setActive(seat: EditorSeatIndex): void { void seat; }
  setOrder(order: EditorSeatIndex[]): void { void order; }
  isEnabled(): boolean { return false; }
  getActive(): EditorSeatIndex | null { return null; }
  getOrder(): EditorSeatIndex[] { return []; }
  getTurnNumber(): number { return 0; }
}

export class EditorSceneFacade {
  declare readonly assets: EditorAssetsApi;
  declare readonly turns:  EditorTurnsApi;
  getObjectById(id: string): EditorEntityFacade | undefined { void id; return undefined; }
  getTable(): EditorEntityFacade | undefined { return undefined; }
  getObjectsByTag(tag: string): EditorEntityFacade[] { void tag; return []; }
  playSound(slug: string): void { void slug; }
  attachSticker(parent: EditorEntityFacade, opts: EditorStickerOpts): EditorElementHandle | null {
    void parent; void opts; return null;
  }
  getElement(surfaceId: string, elementId: string): EditorElementHandle | null {
    void surfaceId; void elementId; return null;
  }
}

export class EditorGame {
  declare scene: unknown;
  onSceneInitialised(scene: EditorSceneFacade): void { void scene; }
  onScriptLoaded(scene: EditorSceneFacade): void { void scene; }
  onTurnStart(seat: EditorSeatIndex, turnNumber: number): void { void seat; void turnNumber; }
  onTurnEnd(seat: EditorSeatIndex, turnNumber: number, endedBy: EditorEndedBy): void {
    void seat; void turnNumber; void endedBy;
  }
  onTurnEndRequested(seat: EditorSeatIndex): void { void seat; }
}

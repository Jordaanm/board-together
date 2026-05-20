// Single-call composition for the "one clickable element on a 3D object"
// case (issue #9 of issues--ui-surface.md, refactored for issue #2 of
// issues--ui-surface-refactor.md). Produces a child surface entity (prim:
// plane mesh + SurfaceComponent) plus one element appended to that surface's
// `state.elements` array. The element is no longer a separate entity — it's
// data on the surface, addressable through `ElementHandle`.
//
// V1 uses manual face math against the parent's `MeshComponent.halfExtents`.
// Surface is positioned in the parent's local frame and oriented so its +Z
// normal points outward from the requested face.

import * as THREE from 'three';
import { Entity } from '../Entity';
import { type SceneImpl } from '../Scene';
import { type SpawnContext } from '../EntityComponent';
import { TransformComponent } from './TransformComponent';
import { MeshComponent } from './MeshComponent';
import { SurfaceComponent } from './SurfaceComponent';
import {
  type SurfaceElement,
  type EditorElementKind,
  type ImageFit,
  type ShapeShape,
  newElementId,
  makeDefaultElement,
} from './SurfaceElement';
import { ElementHandle, entitySceneLookup } from './ElementHandle';
import { type ScriptRunContext } from '../../scripting/EntityFacade';

export type StickerFace = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

export interface ShapeContent {
  shape: {
    kind:         ShapeShape;
    fill?:        string;
    stroke?:      string;
    strokeWidth?: number;
    radius?:      number;
  };
}

export interface ImageContent {
  image: string;
  fit?:  ImageFit;
}

export interface RichContent {
  html: string;
}

export interface ButtonContent {
  button: {
    normal:   string;
    hovered?: string;
    pressed?: string;
    fit?:     ImageFit;
  };
}

export type StickerContent = ShapeContent | ImageContent | RichContent | ButtonContent;

export interface StickerOpts {
  face:        StickerFace;
  // World-space size of the surface plane: [width, height]. Defaults to a
  // unit square — authors typically scale to the parent's face dimensions.
  size?:       [number, number];
  // Off-surface offset from the face plane. Default ε so the sticker doesn't
  // z-fight with the parent face geometry.
  offset?:     number;
  // Pixel size of the offscreen canvas backing the surface. Defaults
  // [512, 512]; authors bump for crispness on physically-larger surfaces.
  canvasSize?: [number, number];
  // Element content. Exactly one of `shape | image | html` must be present.
  content:     StickerContent;
}

const DEFAULT_OFFSET = 0.001;

export interface AttachStickerResult {
  surfaceEntity: Entity;
  elementHandle: ElementHandle;
}

// Surface-only spawn options — the subset of StickerOpts that controls the
// child surface entity itself (no element). Used by `createSurfaceChild` and
// shared with `attachSticker`. `face` defaults to `'top'` when omitted.
export interface SurfaceChildOpts {
  face?:       StickerFace;
  size?:       [number, number];
  offset?:     number;
  canvasSize?: [number, number];
}

// Creates the surface entity (transform + plane mesh + SurfaceComponent) as
// a child of `parent`, parented to the requested face. Runs onSpawn for each
// component and registers the entity in `scene`. Replication is the caller's
// responsibility — see `World.attachSurface` / `World.attachSticker`.
export function createSurfaceChild(
  scene:  SceneImpl,
  ctx:    SpawnContext,
  parent: Entity,
  opts:   SurfaceChildOpts,
): Entity {
  const parentMesh = parent.getComponent(MeshComponent);
  if (!parentMesh) {
    throw new Error(`createSurfaceChild: parent ${parent.id} has no MeshComponent`);
  }

  const halfExtents = parentMesh.halfExtents();
  const offset      = opts.offset ?? DEFAULT_OFFSET;
  const canvasSize  = opts.canvasSize ?? [512, 512];
  const face        = opts.face ?? 'top';
  const size        = opts.size ?? defaultSurfaceSize(face, halfExtents);
  const { position, rotation } = faceTransform(face, halfExtents, offset);

  const surfaceId = newElementId();
  const surfaceEntity = new Entity({
    id:       surfaceId,
    type:     'sticker-surface',
    name:     `${parent.name}/sticker`,
    parentId: parent.id,
  });
  const transform = new TransformComponent();
  transform.fromJSON({ position, rotation, scale: [1, 1, 1] });
  surfaceEntity.attachComponent(transform);
  const mesh = new MeshComponent();
  mesh.fromJSON({
    meshRef:     'prim:plane',
    textureRefs: { default: '' },
    color:       '#ffffff',
    applyTint:   false,
    width:       size[0],
    height:      0,
    depth:       size[1],
  });
  surfaceEntity.attachComponent(mesh);
  const surface = new SurfaceComponent();
  surface.fromJSON({ canvasSize, elements: [] });
  surfaceEntity.attachComponent(surface);
  parent.children.push(surfaceId);
  scene.add(surfaceEntity);
  transform.onSpawn(ctx);
  mesh.onSpawn(ctx);
  surface.onSpawn(ctx);

  return surfaceEntity;
}

// Appends one element to `surface`'s `state.elements` array using the editor-
// kind defaults, replicates through the SurfaceComponent's standard patch
// path, and returns the new element id. Backs `World.attachElement`.
export function appendDefaultElement(
  surface: Entity,
  kind:    EditorElementKind,
): string {
  const surfaceComp = surface.getComponent(SurfaceComponent);
  if (!surfaceComp) {
    throw new Error(`appendDefaultElement: entity ${surface.id} has no SurfaceComponent`);
  }
  return surfaceComp.attachElement(kind);
}

// Creates the surface child + appends one element matching `opts.content` and
// returns both the surface entity and an ElementHandle wrapping the new
// element. Optional ScriptRunContext threads through into the handle so
// SceneFacade-side `addEventListener` calls can be torn down on Run swap.
export function attachSticker(
  scene:  SceneImpl,
  ctx:    SpawnContext,
  parent: Entity,
  opts:   StickerOpts,
  runCtx: ScriptRunContext | null = null,
): AttachStickerResult {
  const surfaceEntity = createSurfaceChild(scene, ctx, parent, opts);
  const surfaceComp   = surfaceEntity.getComponent(SurfaceComponent)!;
  const [w, h]        = surfaceComp.state.canvasSize;
  const element       = makeElementFromContent(opts.content, w, h);
  const elementId     = surfaceComp.addElement(element);
  const elementHandle = new ElementHandle(
    surfaceEntity.id,
    elementId,
    entitySceneLookup(scene),
    runCtx,
  );
  return { surfaceEntity, elementHandle };
}

function makeElementFromContent(content: StickerContent, w: number, h: number): SurfaceElement {
  if ('html' in content) {
    return { id: newElementId(), kind: 'rich', x: 0, y: 0, w, h, html: content.html };
  }
  if ('image' in content) {
    return {
      id:         newElementId(),
      kind:       'image',
      x: 0, y: 0, w, h,
      textureRef: content.image,
      fit:        content.fit ?? 'fit',
    };
  }
  if ('button' in content) {
    return {
      id:         newElementId(),
      kind:       'button',
      x: 0, y: 0, w, h,
      normalRef:  content.button.normal,
      hoveredRef: content.button.hovered,
      pressedRef: content.button.pressed,
      fit:        content.button.fit ?? 'fit',
    };
  }
  // Shape — fall back to a sensible fill if the author didn't supply one;
  // matches the existing `add-shape-rect` editor button default.
  const base = makeDefaultElement(content.shape.kind === 'circle' ? 'shape-circle' : 'shape-rect', w, h);
  if (base.kind !== 'shape') return base;  // narrow guard
  return {
    ...base,
    fill:        content.shape.fill        ?? base.fill,
    stroke:      content.shape.stroke,
    strokeWidth: content.shape.strokeWidth,
    radius:      content.shape.radius,
  };
}

// Picks an in-plane size that covers the parent's face. Width / height
// are the two axes orthogonal to the face normal.
function defaultSurfaceSize(face: StickerFace, h: [number, number, number]): [number, number] {
  const [hx, hy, hz] = h;
  switch (face) {
    case 'top':
    case 'bottom': return [hx * 2, hz * 2];
    case 'front':
    case 'back':   return [hx * 2, hy * 2];
    case 'left':
    case 'right':  return [hz * 2, hy * 2];
  }
}

// Maps a face to (position offset from parent center, quaternion that
// rotates +Z to the face's outward normal). Result is in the parent's local
// coordinate frame; the surface entity carries this transform directly so
// no nested-transform math is needed at render time.
function faceTransform(
  face: StickerFace,
  halfExtents: [number, number, number],
  offset: number,
): { position: [number, number, number]; rotation: [number, number, number, number] } {
  const [hx, hy, hz] = halfExtents;
  const q = new THREE.Quaternion();
  let position: [number, number, number];
  switch (face) {
    case 'top':
      position = [0, hy + offset, 0];
      q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
      break;
    case 'bottom':
      position = [0, -hy - offset, 0];
      q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
      break;
    case 'front':
      position = [0, 0, hz + offset];
      // identity — plane already faces +Z.
      break;
    case 'back':
      position = [0, 0, -hz - offset];
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
      break;
    case 'left':
      position = [-hx - offset, 0, 0];
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
      break;
    case 'right':
      position = [hx + offset, 0, 0];
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
      break;
  }
  return {
    position,
    rotation: [q.x, q.y, q.z, q.w],
  };
}

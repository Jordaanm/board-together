// Tool catalogue — issue 2a of issues--tools.md.
//
// Static array seed for v1. A runtime ToolRegistry will be promoted from this
// once scripting needs to author tools (see PRD § Out of Scope).

import * as THREE from 'three';
import { type MoveGizmo } from '../../scene/MoveGizmo';
import { RotateGizmo } from '../../scene/RotateGizmo';
import { GrabTool } from './GrabTool';
import { PingTool } from './PingTool';
import { FlickTool } from './FlickTool';
import { AxisGizmoAttachment } from './AxisGizmoAttachment';
import { FlickArrowAttachment } from './FlickArrowAttachment';
import { HitboxAttachment } from './HitboxAttachment';
import { DropPreviewGhost } from './DropPreviewGhost';
import { MarqueeOverlay } from './MarqueeOverlay';
import { type Tool } from './types';
import { type SelectionClickModifier } from '../SelectionStore';

export { ToolDispatcher, type ToolDispatcherDeps } from './ToolDispatcher';
export { GrabTool } from './GrabTool';
export { PingTool } from './PingTool';
export { FlickTool } from './FlickTool';
export { AxisGizmoAttachment } from './AxisGizmoAttachment';
export { FlickArrowAttachment } from './FlickArrowAttachment';
export { HitboxAttachment } from './HitboxAttachment';
export { DropPreviewGhost } from './DropPreviewGhost';
export { MarqueeOverlay } from './MarqueeOverlay';
export type { Tool, ToolContext, ToolPointerEvent, ToolAttachment } from './types';

export interface ToolFactoryDeps {
  scene:           THREE.Scene;
  // Canvas container — the marquee overlay attaches into this element so it
  // floats above the canvas without leaking outside the room's viewport.
  canvasContainer: HTMLElement;
  moveGizmo:       MoveGizmo;
  onSelect:        (id: string | null, modifier: SelectionClickModifier) => void;
  onMarqueeCommit: (candidates: ReadonlySet<string>, modifier: SelectionClickModifier) => void;
  onMarqueeChange: (candidates: ReadonlySet<string>) => void;
}

export interface ToolFactory {
  readonly id:      string;
  readonly label:   string;
  readonly hotkey?: string;
  create(deps: ToolFactoryDeps): Tool;
}

// Tool catalogue. Slot order maps to numeric hotkeys (#2b).
export const TOOL_CATALOGUE: ToolFactory[] = [
  {
    id:     'grab',
    label:  'Grab',
    hotkey: '1',
    create: (deps) => {
      const rotateGizmo = new RotateGizmo();
      return new GrabTool(
        deps.moveGizmo,
        rotateGizmo,
        new AxisGizmoAttachment(deps.scene, deps.moveGizmo, rotateGizmo),
        new HitboxAttachment(deps.scene),
        new DropPreviewGhost(deps.scene),
        new MarqueeOverlay(deps.canvasContainer),
        deps.onSelect,
        deps.onMarqueeCommit,
        deps.onMarqueeChange,
      );
    },
  },
  {
    id:     'ping',
    label:  'Ping',
    hotkey: '2',
    create: () => new PingTool(),
  },
  {
    id:     'flick',
    label:  'Flick',
    hotkey: '3',
    create: (deps) => new FlickTool(new FlickArrowAttachment(deps.scene)),
  },
];

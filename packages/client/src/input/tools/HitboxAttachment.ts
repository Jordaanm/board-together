// HitboxAttachment — debug overlay that wireframes the cannon collision
// shape of the currently-selected entity. Wired in parallel with
// AxisGizmoAttachment by GrabTool. Gated by a host-only "Show Hitboxes"
// toggle: when off, attach() is a silent no-op.

import * as THREE from 'three';
import { type EntityHandle } from '../../entity/world';
import { PhysicsComponent } from '../../entity/components/PhysicsComponent';
import { buildHitboxWireframe } from '../../physics/hitboxWireframe';
import { type ToolAttachment, type ToolContext } from './types';

export class HitboxAttachment implements ToolAttachment {
  private attached = false;
  private group:    THREE.Group | null = null;
  private body:     import('cannon-es').Body | null = null;

  constructor(private readonly scene: THREE.Scene) {}

  // Mutable so Room.tsx can toggle without rebuilding the attachment. When
  // flipped off mid-inspection, the next syncAttachment / selection change
  // tears down via detach; flipped on with a live selection re-attaches.
  enabled = false;

  setEnabled(on: boolean, currentSelection: EntityHandle | null, ctx: ToolContext | null): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) {
      this.detach();
      return;
    }
    if (currentSelection && ctx) this.attach(currentSelection, ctx);
  }

  attach(handle: EntityHandle, _ctx: ToolContext): void {
    if (!this.enabled) return;
    // Re-attach over an active selection — drop the prior overlay before
    // building the new one so a selection change doesn't leak the previous
    // entity's wireframes into the scene.
    if (this.attached) this.detach();

    const phys = handle.get(PhysicsComponent);
    if (!phys?.body) return; // silent no-op for entities without physics

    const group = new THREE.Group();
    group.name = 'HitboxAttachment';
    group.renderOrder = 999;
    for (let i = 0; i < phys.body.shapes.length; i++) {
      const shape = phys.body.shapes[i];
      const offset = phys.body.shapeOffsets[i];
      const orient = phys.body.shapeOrientations[i];
      const wire   = buildHitboxWireframe(shape);
      wire.position.set(offset.x, offset.y, offset.z);
      wire.quaternion.set(orient.x, orient.y, orient.z, orient.w);
      group.add(wire);
    }
    const bodyPos = phys.body.position;
    const bodyQuat = phys.body.quaternion;
    group.position.set(bodyPos.x, bodyPos.y, bodyPos.z);
    group.quaternion.set(bodyQuat.x, bodyQuat.y, bodyQuat.z, bodyQuat.w);

    this.scene.add(group);
    this.group    = group;
    this.body     = phys.body;
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    if (this.group) {
      this.scene.remove(this.group);
      disposeGroup(this.group);
    }
    this.group    = null;
    this.body     = null;
    this.attached = false;
  }

  update(_dt: number): void {
    if (!this.attached || !this.group || !this.body) return;
    const p = this.body.position;
    const q = this.body.quaternion;
    this.group.position.set(p.x, p.y, p.z);
    this.group.quaternion.set(q.x, q.y, q.z, q.w);
  }

  isAttached(): boolean {
    return this.attached;
  }
}

function disposeGroup(group: THREE.Object3D): void {
  group.traverse((child) => {
    if (child instanceof THREE.LineSegments) {
      child.geometry?.dispose?.();
      // Material is shared across all instances — never dispose here.
    }
  });
}

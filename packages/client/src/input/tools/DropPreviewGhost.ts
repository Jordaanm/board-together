// DropPreviewGhost — translucent clone of the dragged entity's mesh shown
// at the projected drop point during a drag. Local-only: never enters the
// scene-replication state machine, never visible to other players. Issue #3
// of planning/issues--drag-refactor.md.
//
// Lifecycle mirrors HitboxAttachment: attach() clones the dragged mesh and
// adds it to the local THREE.Scene, update() syncs pose each frame against
// the most recent resolved surface Y (null hides the ghost), detach() tears
// the clone down and disposes the override materials we created.

import * as THREE from 'three';
import { GHOST_ALPHA } from '../../config/dragConfig';
import { TransformComponent } from '../../entity/components/TransformComponent';
import { type EntityHandle } from '../../entity/world';

export class DropPreviewGhost {
  private group:            THREE.Object3D | null = null;
  private handle:           EntityHandle | null = null;
  // Materials we instantiate ourselves so detach() can dispose them. Original
  // entity materials are shared by clone(true) and must not be touched.
  private overrideMaterials: THREE.Material[] = [];

  constructor(private readonly scene: THREE.Scene) {}

  attach(handle: EntityHandle): void {
    if (this.group) this.detach();
    const t = handle.get(TransformComponent);
    if (!t?.object3d) return;

    const clone = t.object3d.clone(true);
    clone.name = 'DropPreviewGhost';
    // Swap every mesh material for a translucent override so the ghost reads
    // as a faint silhouette regardless of the source material's complexity.
    clone.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const ghost = new THREE.MeshBasicMaterial({
          color:       0xffffff,
          transparent: true,
          opacity:     GHOST_ALPHA,
          depthWrite:  false,
        });
        child.material = ghost;
        this.overrideMaterials.push(ghost);
      }
    });
    // Hidden until the first update() supplies a resolved surface Y.
    clone.visible = false;
    this.scene.add(clone);
    this.group  = clone;
    this.handle = handle;
  }

  // Per-frame sync. `surfaceY === null` corresponds to the resolver's `none`
  // kind (off-table fallback) — hide the ghost rather than ghost-stamp the
  // fallback plane. XZ follows the dragged entity's current pose; rotation
  // matches the dragged entity's current rotation.
  update(surfaceY: number | null): void {
    if (!this.group || !this.handle) return;
    if (surfaceY === null) {
      this.group.visible = false;
      return;
    }
    const t = this.handle.get(TransformComponent);
    if (!t?.object3d) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    const obj = t.object3d;
    this.group.position.set(obj.position.x, surfaceY, obj.position.z);
    this.group.quaternion.copy(obj.quaternion);
  }

  detach(): void {
    if (this.group) {
      this.scene.remove(this.group);
      this.group = null;
    }
    for (const m of this.overrideMaterials) m.dispose();
    this.overrideMaterials = [];
    this.handle = null;
  }

  isAttached(): boolean {
    return this.group !== null;
  }
}

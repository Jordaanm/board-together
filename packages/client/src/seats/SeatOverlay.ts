// 3D overlay that draws one colored disk + yaw chevron per seat. Visible only
// while the Table is the selected entity in the editor. Visual-only — never
// added to any input raycast target.

import * as THREE from 'three';
import { SEAT_COLOURS } from './SeatLayout';
import { seatPoseFromState, type SeatState } from './SeatPoseState';
import { TABLE_SURFACE_Y } from '../scene/Table';

const SEAT_COUNT      = 8;
const DISK_RADIUS     = 0.3;     // diameter ~0.6
const DISK_LIFT       = 0.025;   // above table surface to avoid z-fighting
const DISK_OPACITY    = 0.85;
const CHEVRON_LIFT    = 0.005;   // tiny extra lift to render on top of disk
const CHEVRON_LENGTH  = 0.22;
const CHEVRON_WIDTH   = 0.18;

interface SeatEntry {
  group:    THREE.Group;
  disk:     THREE.Mesh;
  chevron:  THREE.Mesh;
}

export class SeatOverlay {
  readonly group = new THREE.Group();
  private readonly entries: SeatEntry[] = [];

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < SEAT_COUNT; i++) {
      const entry = makeSeatEntry(SEAT_COLOURS[i]);
      this.entries.push(entry);
      this.group.add(entry.group);
    }
    this.group.visible = false;
    scene.add(this.group);
  }

  // Reposition each seat marker to match `seats`. `visible` toggles the group;
  // when false, geometry stays in place but is hidden. Called every frame from
  // the animate loop — cheap (8 transforms).
  sync(seats: readonly SeatState[] | null | undefined, visible: boolean): void {
    if (!seats || seats.length === 0) {
      this.group.visible = false;
      return;
    }
    this.group.visible = visible;
    if (!visible) return;
    const n = Math.min(seats.length, this.entries.length);
    for (let i = 0; i < n; i++) {
      const s     = seats[i];
      const pose  = seatPoseFromState(s);
      const entry = this.entries[i];
      entry.group.position.set(pose.position.x, TABLE_SURFACE_Y + DISK_LIFT, pose.position.z);
      // yaw rotates around Y. The chevron mesh is built pointing toward -Z
      // (matching yaw = 0); rotating the group by `yaw` makes it point along
      // `facing`. Disk is radially symmetric so the same rotation is harmless.
      entry.group.rotation.set(0, s.yaw, 0);
    }
  }

  // Hide an individual seat marker (used when its name plane is hidden during
  // gizmo-edit; included here so the same group can be opt-out per-index).
  setSeatVisible(i: number, visible: boolean): void {
    const entry = this.entries[i];
    if (entry) entry.group.visible = visible;
  }

  dispose(): void {
    for (const entry of this.entries) {
      entry.group.removeFromParent();
      entry.disk.geometry.dispose();
      (entry.disk.material as THREE.Material).dispose();
      entry.chevron.geometry.dispose();
      (entry.chevron.material as THREE.Material).dispose();
    }
    this.entries.length = 0;
    this.group.removeFromParent();
  }
}

function makeSeatEntry(color: string): SeatEntry {
  const group = new THREE.Group();

  const diskGeom = new THREE.CircleGeometry(DISK_RADIUS, 32);
  diskGeom.rotateX(-Math.PI / 2);
  const diskMat  = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity:     DISK_OPACITY,
    depthTest:   false,
  });
  const disk = new THREE.Mesh(diskGeom, diskMat);
  disk.renderOrder = 996;
  group.add(disk);

  // Chevron: isoceles triangle on the XZ plane, apex toward -Z (facing forward
  // when yaw = 0). Built via BufferGeometry so we keep a single triangle.
  const chevronGeom = new THREE.BufferGeometry();
  const halfW = CHEVRON_WIDTH / 2;
  const verts = new Float32Array([
    0,        0, -CHEVRON_LENGTH,  // apex
   -halfW,    0,  0,                // back-left
    halfW,    0,  0,                // back-right
  ]);
  chevronGeom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  chevronGeom.setIndex([0, 1, 2]);
  chevronGeom.computeVertexNormals();
  const chevronMat = new THREE.MeshBasicMaterial({
    color:       '#111111',
    transparent: true,
    opacity:     0.9,
    depthTest:   false,
    side:        THREE.DoubleSide,
  });
  const chevron = new THREE.Mesh(chevronGeom, chevronMat);
  chevron.position.y = CHEVRON_LIFT;
  chevron.renderOrder = 997;
  group.add(chevron);

  return { group, disk, chevron };
}

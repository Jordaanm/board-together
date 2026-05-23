// 3D overlay for seat markers and floating name labels.
//
//   • Disk + yaw chevron per seat — visible only while the Table is selected.
//   • Flat name plane per occupied seat — always visible to all peers, in the
//     seat's colour. Re-rendered when the display name, occupancy, pose, or
//     selection state changes.
//
// Visual-only: the meshes are never added to any input raycast target.

import * as THREE from 'three';
import { SEAT_COLOURS } from './SeatLayout';
import { seatPoseFromState, type SeatState } from './SeatPoseState';
import { TABLE_SURFACE_Y } from '../scene/Table';

const SEAT_COUNT      = 8;

const DISK_RADIUS     = 0.3;     // diameter ~0.6
const DISK_LIFT       = 0.025;   // above table surface to avoid z-fighting
const DISK_OPACITY    = 0.85;
const CHEVRON_LIFT    = 0.005;
const CHEVRON_LENGTH  = 0.22;
const CHEVRON_WIDTH   = 0.18;

const NAME_PLANE_LIFT  = 0.015;
const NAME_PLANE_WIDTH = 1.2;
const NAME_INSET       = 0.3;    // distance toward table centre from seat pos
const NAME_CANVAS_W    = 384;    // texture size; aspect matches plane
const NAME_CANVAS_H    = 128;
const NAME_FONT        = '600 56px system-ui, sans-serif';
const NAME_STROKE      = 4;      // canvas-space; scales with NAME_CANVAS_*

interface SeatEntry {
  group:    THREE.Group;
  disk:     THREE.Mesh;
  chevron:  THREE.Mesh;
}

interface NameEntry {
  group:        THREE.Group;
  mesh:         THREE.Mesh;
  canvas:       HTMLCanvasElement;
  ctx:          CanvasRenderingContext2D;
  texture:      THREE.CanvasTexture;
  // Cached so we only re-render the canvas when something visible changes.
  renderedName: string;
  renderedColor: string;
}

export interface SeatOverlaySyncState {
  seats:    readonly SeatState[] | null | undefined;
  // Controls disk + chevron visibility. Name planes are not gated by this.
  selected: boolean;
  // Resolved display name per seat (length 8). Empty string → vacant, no plane.
  names:    readonly string[];
}

export class SeatOverlay {
  readonly group = new THREE.Group();
  private readonly markerEntries: SeatEntry[] = [];
  private readonly nameEntries:   (NameEntry | null)[] = [];

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < SEAT_COUNT; i++) {
      const entry = makeSeatEntry(SEAT_COLOURS[i]);
      this.markerEntries.push(entry);
      this.group.add(entry.group);
      this.nameEntries.push(null);
    }
    scene.add(this.group);
  }

  sync(state: SeatOverlaySyncState): void {
    const seats = state.seats;
    if (!seats || seats.length === 0) {
      for (const e of this.markerEntries) e.group.visible = false;
      this.clearAllNamePlanes();
      return;
    }
    const n = Math.min(seats.length, SEAT_COUNT);
    for (let i = 0; i < n; i++) {
      const s    = seats[i];
      const pose = seatPoseFromState(s);
      const marker = this.markerEntries[i];
      marker.group.position.set(pose.position.x, TABLE_SURFACE_Y + DISK_LIFT, pose.position.z);
      // Chevron mesh points toward -Z at yaw=0; rotating the group by yaw
      // makes it point along `facing`. Disk is radially symmetric.
      marker.group.rotation.set(0, s.yaw, 0);
      marker.group.visible = state.selected;

      const rawName = state.names[i] ?? '';
      this.applyNamePlane(i, rawName, pose, s.yaw);
    }
    // Tear down marker / name entries beyond the seats array length.
    for (let i = n; i < SEAT_COUNT; i++) {
      this.markerEntries[i].group.visible = false;
      this.disposeNameEntry(i);
    }
  }

  // Hide an individual seat marker + name plane (used by Issue 5 — actively
  // gizmo-edited seat). Exposed for future wiring; this slice does not call it.
  setSeatHidden(i: number, hidden: boolean): void {
    const marker = this.markerEntries[i];
    if (marker) marker.group.visible = !hidden && marker.group.visible;
    const name = this.nameEntries[i];
    if (name)   name.group.visible   = !hidden;
  }

  dispose(): void {
    for (const e of this.markerEntries) {
      e.group.removeFromParent();
      e.disk.geometry.dispose();
      (e.disk.material as THREE.Material).dispose();
      e.chevron.geometry.dispose();
      (e.chevron.material as THREE.Material).dispose();
    }
    this.markerEntries.length = 0;
    this.clearAllNamePlanes();
    this.group.removeFromParent();
  }

  // ── Name-plane internals ──────────────────────────────────────────────
  private applyNamePlane(i: number, name: string, pose: { position: { x: number; y: number; z: number }; facing: { x: number; y: number; z: number } }, yaw: number): void {
    if (!name) {
      this.disposeNameEntry(i);
      return;
    }
    const colour = SEAT_COLOURS[i];
    let entry = this.nameEntries[i];
    if (!entry) {
      entry = makeNameEntry();
      this.group.add(entry.group);
      this.nameEntries[i] = entry;
    }
    // Inset slightly toward the table centre along the seat's facing dir.
    const px = pose.position.x + NAME_INSET * pose.facing.x;
    const pz = pose.position.z + NAME_INSET * pose.facing.z;
    entry.group.position.set(px, TABLE_SURFACE_Y + NAME_PLANE_LIFT, pz);
    // After rotateX(-π/2), local +Y → world -Z. We want text "top" to point
    // away from the seated player (i.e. in -facing direction), which is
    // world +Z for yaw = 0. Rotate the group by yaw + π around Y.
    entry.group.rotation.set(0, yaw + Math.PI, 0);

    if (entry.renderedName !== name || entry.renderedColor !== colour) {
      drawNameCanvas(entry.ctx, name, colour);
      entry.texture.needsUpdate = true;
      entry.renderedName  = name;
      entry.renderedColor = colour;
    }
    entry.group.visible = true;
  }

  private disposeNameEntry(i: number): void {
    const entry = this.nameEntries[i];
    if (!entry) return;
    entry.group.removeFromParent();
    entry.mesh.geometry.dispose();
    (entry.mesh.material as THREE.Material).dispose();
    entry.texture.dispose();
    this.nameEntries[i] = null;
  }

  private clearAllNamePlanes(): void {
    for (let i = 0; i < this.nameEntries.length; i++) this.disposeNameEntry(i);
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

  // Chevron: isoceles triangle on the XZ plane, apex toward -Z (forward when
  // yaw = 0). Single triangle via BufferGeometry.
  const chevronGeom = new THREE.BufferGeometry();
  const halfW = CHEVRON_WIDTH / 2;
  const verts = new Float32Array([
    0,        0, -CHEVRON_LENGTH,
   -halfW,    0,  0,
    halfW,    0,  0,
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

function makeNameEntry(): NameEntry {
  const canvas = document.createElement('canvas');
  canvas.width  = NAME_CANVAS_W;
  canvas.height = NAME_CANVAS_H;
  const ctx = canvas.getContext('2d')!;

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  texture.minFilter  = THREE.LinearFilter;
  texture.magFilter  = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;

  const planeH = NAME_PLANE_WIDTH * (NAME_CANVAS_H / NAME_CANVAS_W);
  const geom = new THREE.PlaneGeometry(NAME_PLANE_WIDTH, planeH);
  geom.rotateX(-Math.PI / 2);
  const mat  = new THREE.MeshBasicMaterial({
    map:         texture,
    transparent: true,
    depthTest:   false,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.renderOrder = 998;

  const group = new THREE.Group();
  group.add(mesh);

  return {
    group, mesh, canvas, ctx, texture,
    renderedName:  '',
    renderedColor: '',
  };
}

function drawNameCanvas(ctx: CanvasRenderingContext2D, name: string, color: string): void {
  ctx.clearRect(0, 0, NAME_CANVAS_W, NAME_CANVAS_H);
  ctx.font         = NAME_FONT;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin     = 'round';
  ctx.miterLimit   = 2;

  ctx.lineWidth   = NAME_STROKE;
  ctx.strokeStyle = '#111111';
  ctx.strokeText(name, NAME_CANVAS_W / 2, NAME_CANVAS_H / 2);

  ctx.fillStyle = color;
  ctx.fillText(name, NAME_CANVAS_W / 2, NAME_CANVAS_H / 2);
}

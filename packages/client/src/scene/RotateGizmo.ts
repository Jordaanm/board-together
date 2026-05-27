// RotateGizmo — Y-axis (yaw) rotation ring.
//
// Used by AxisGizmoAttachment as the multi-selection centroid gizmo.
// Tabletop play is overwhelmingly yaw rotation (entities sit on the table
// surface), so this slice ships a single Y-axis ring rather than a full
// XYZ orbiter. The picker is a flat torus the cursor must hit; drag math
// lives in the GrabTool which converts pointer rays into angle deltas.

import * as THREE from 'three';

const RING_RADIUS    = 1.0;
const RING_TUBE      = 0.04;
const PICKER_RADIUS  = 0.10;
const PICKER_SEGMENTS = 32;

export class RotateGizmo {
  readonly group   = new THREE.Group();
  private readonly torus:     THREE.Mesh;
  private readonly torusGeom: THREE.TorusGeometry;
  private readonly torusMat:  THREE.MeshBasicMaterial;
  private readonly picker:     THREE.Mesh;
  private readonly pickerGeom: THREE.TorusGeometry;
  private readonly pickerMat:  THREE.MeshBasicMaterial;
  private target: THREE.Object3D | null = null;

  constructor() {
    this.torusGeom = new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 8, 48);
    this.torusMat  = new THREE.MeshBasicMaterial({ color: 0x3bff3b, depthTest: false, transparent: true });
    this.torus     = new THREE.Mesh(this.torusGeom, this.torusMat);
    // TorusGeometry lies in the XY plane; rotate so it lies in the XZ plane
    // (yaw ring around world +Y).
    this.torus.rotation.x = Math.PI / 2;
    this.torus.renderOrder = 999;
    this.group.add(this.torus);

    this.pickerGeom = new THREE.TorusGeometry(RING_RADIUS, PICKER_RADIUS, 6, PICKER_SEGMENTS);
    this.pickerMat  = new THREE.MeshBasicMaterial({ visible: false });
    this.picker     = new THREE.Mesh(this.pickerGeom, this.pickerMat);
    this.picker.rotation.x = Math.PI / 2;
    this.picker.userData.gizmoAxis = 'yaw';
    this.group.add(this.picker);
  }

  attach(target: THREE.Object3D) {
    this.target = target;
    this.update();
  }

  detach() { this.target = null; }

  hasTarget(): boolean { return this.target !== null; }
  getTarget(): THREE.Object3D | null { return this.target; }

  update() {
    if (!this.target) return;
    this.group.position.copy(this.target.position);
  }

  pickRing(raycaster: THREE.Raycaster): boolean {
    if (!this.target || !this.group.parent) return false;
    return raycaster.intersectObject(this.picker, false).length > 0;
  }

  dispose() {
    this.torusGeom.dispose();
    this.torusMat.dispose();
    this.pickerGeom.dispose();
    this.pickerMat.dispose();
    this.group.clear();
    this.target = null;
  }
}

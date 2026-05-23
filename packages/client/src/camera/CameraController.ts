import * as THREE from 'three';

const TWO_PI = Math.PI * 2;

interface Options {
  radius?: number;
  theta?: number;
  phi?: number;
  minPhi?: number;
  maxPhi?: number;
  minRadius?: number;
  maxRadius?: number;
  floorY?: number;
}

export class CameraController {
  readonly target = new THREE.Vector3();

  private radius: number;
  private theta: number;
  private phi: number;
  private readonly minPhi: number;
  private readonly maxPhi: number;
  private readonly minRadius: number;
  private readonly maxRadius: number;
  private readonly floorY: number;

  private restricted = false;
  private dragging = false;
  private dragButton = -1;
  private lastX = 0;
  private lastY = 0;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly element: HTMLElement,
    opts: Options = {}
  ) {
    this.radius = opts.radius ?? 14;
    this.theta = opts.theta ?? Math.PI / 4;
    this.phi = opts.phi ?? Math.PI / 3.5;
    this.minPhi = opts.minPhi ?? 0.08;
    this.maxPhi = opts.maxPhi ?? Math.PI / 2 - 0.05;
    this.minRadius = opts.minRadius ?? 3;
    this.maxRadius = opts.maxRadius ?? 35;
    this.floorY = opts.floorY ?? 0.5;

    element.addEventListener('pointerdown', this.onDown);
    element.addEventListener('pointermove', this.onMove);
    element.addEventListener('pointerup', this.onUp);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    element.addEventListener('contextmenu', this.suppressMenu);

    this.apply();
  }

  setRestricted(on: boolean) {
    this.restricted = on;
    this.apply();
  }

  // One-shot orbit mutation used by the seat-assignment snap. Caller computes
  // theta + target from the pure helper; radius and phi are preserved. The
  // camera reverts to free orbit afterward — no lock mode.
  snapOrbit(theta: number, target: { x: number; y: number; z: number }): void {
    this.theta = ((theta % TWO_PI) + TWO_PI) % TWO_PI;
    this.target.set(target.x, target.y, target.z);
    this.apply();
  }

  dispose() {
    this.element.removeEventListener('pointerdown', this.onDown);
    this.element.removeEventListener('pointermove', this.onMove);
    this.element.removeEventListener('pointerup', this.onUp);
    this.element.removeEventListener('wheel', this.onWheel);
    this.element.removeEventListener('contextmenu', this.suppressMenu);
  }

  private suppressMenu = (e: Event) => e.preventDefault();

  private onDown = (e: PointerEvent) => {
    if (e.button !== 1 && e.button !== 2) return;
    this.dragging = true;
    this.dragButton = e.button;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.element.setPointerCapture(e.pointerId);
  };

  private onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;

    if (this.dragButton === 2) {
      this.orbit(dx, dy);
    } else if (this.dragButton === 1) {
      this.pan(dx, dy);
    }
  };

  private onUp = (e: PointerEvent) => {
    if (e.button === this.dragButton) { this.dragging = false; this.dragButton = -1; }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.radius = THREE.MathUtils.clamp(
      this.radius + e.deltaY * 0.02,
      this.minRadius,
      this.maxRadius
    );
    this.apply();
  };

  private orbit(dx: number, dy: number) {
    this.theta = ((this.theta - dx * 0.005) % TWO_PI + TWO_PI) % TWO_PI;
    this.phi -= dy * 0.005;
    if (!this.restricted) {
      this.phi = THREE.MathUtils.clamp(this.phi, this.minPhi, this.maxPhi);
    }
    this.apply();
  }

  private pan(dx: number, dy: number) {
    const speed = this.radius * 0.0012;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    right.y = 0;
    right.normalize();

    const forward = new THREE.Vector3(-Math.sin(this.theta), 0, -Math.cos(this.theta));

    this.target.addScaledVector(right, -dx * speed);
    this.target.addScaledVector(forward, -dy * speed);

    if (!this.restricted) {
      this.target.y = Math.max(0, this.target.y);
    }
    this.apply();
  }

  private apply() {
    const sp = Math.sin(this.phi);
    const cp = Math.cos(this.phi);
    const st = Math.sin(this.theta);
    const ct = Math.cos(this.theta);

    this.camera.position.set(
      this.target.x + this.radius * sp * st,
      this.target.y + this.radius * cp,
      this.target.z + this.radius * sp * ct
    );

    if (!this.restricted) {
      this.camera.position.y = Math.max(this.floorY, this.camera.position.y);
    }

    this.camera.lookAt(this.target);
  }
}

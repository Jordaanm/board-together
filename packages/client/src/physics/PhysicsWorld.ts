import * as CANNON from 'cannon-es';

// cannon-es has no CCD, so tunneling is bounded purely by step size.
// 1/240s × MAX_LINEAR_VELOCITY (30 m/s) = 0.125m max travel per step,
// safely under the smallest collidable (token radius 0.5, height 0.15).
const FIXED_STEP    = 1 / 240;
const MAX_SUB_STEPS = 16;

// Post-step velocity clamps. Stops chaotic collisions from launching items
// across the table and keeps per-step travel inside the tunneling budget
// above. Linear cap matches FLICK_MAX_MAGNITUDE (the deliberate-flick max),
// so collisions can't exceed what a player could intentionally produce.
const MAX_LINEAR_VELOCITY  = 30;   // m/s
const MAX_ANGULAR_VELOCITY = 30;   // rad/s

export class PhysicsWorld {
  readonly world: CANNON.World;

  constructor() {
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  }

  addBody(body: CANNON.Body) {
    this.world.addBody(body);
  }

  step(dt: number) {
    this.world.step(FIXED_STEP, dt, MAX_SUB_STEPS);
    this.clampVelocities();
  }

  private clampVelocities() {
    for (const body of this.world.bodies) {
      if (body.type !== CANNON.Body.DYNAMIC) continue;
      clampVec(body.velocity,        MAX_LINEAR_VELOCITY);
      clampVec(body.angularVelocity, MAX_ANGULAR_VELOCITY);
    }
  }
}

function clampVec(v: CANNON.Vec3, max: number) {
  const len = v.length();
  if (len > max) v.scale(max / len, v);
}

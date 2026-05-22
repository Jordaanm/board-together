// Distance above the table surface that a held object is lifted to while
// being dragged.
export const CARRY_LIFT_HEIGHT = 0.3;

// Vertical gap between the surface directly under the cursor and the bottom
// of the dragged object's hitbox. Final hover Y is computed as
// `surfaceY + HOVER_OFFSET + halfExtentY`. Issue #2 of issues--drag-refactor.md.
export const HOVER_OFFSET = 0.1;

// Time constant (seconds) for the exponential Y-ease as the dragged entity
// transitions between hover heights. Lower = snappier, higher = floatier.
export const Y_LERP_TIME_CONSTANT_S = 0.1;

// Alpha for the local-only drop-preview ghost mesh shown beneath the
// dragged object. Issue #3 of issues--drag-refactor.md.
export const GHOST_ALPHA = 0.3;

// Throw velocity is computed from cursor samples within this many ms of
// release. A stationary gap longer than this drops the object straight down.
export const THROW_VELOCITY_WINDOW_MS = 80;

// Cursor speed (world units/sec) at release that switches between
// "throw velocity applied" and "DYNAMIC drop-from-hover". Above the
// threshold the existing flick behaviour fires; at or below, the body goes
// DYNAMIC with zero velocity and gravity drops it. Same threshold gates the
// drop-preview ghost visibility during the drag. Issue #4 of
// issues--drag-refactor.md.
export const THROW_VELOCITY_THRESHOLD = 2.0;

// Press-vs-hold classification for GrabTool. A pointer down commits to a
// carry when the cursor moves past GRAB_MOVE_THRESHOLD_PX from the press
// point (fast move = short press) or the hold timer elapses past
// GRAB_LONG_PRESS_MS without movement (slow/still = long press). Lifted out
// of GrabTool so other tools/tests can share the same numbers.
export const GRAB_LONG_PRESS_MS      = 150;
export const GRAB_MOVE_THRESHOLD_PX  = 5;

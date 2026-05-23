// Pure seat data + default layout resolver. No THREE / CANNON / DOM imports.
// Foundational module for prd--seats-MVP — referenced by RoomState,
// OwnershipPolicy, and (future) PRD-2 Hands.

export type SeatIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const SEAT_COLOURS = [
  'white', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink',
] as const;

export type SeatColour = typeof SEAT_COLOURS[number];

export interface Vec3   { x: number; y: number; z: number; }
export interface SeatPose { position: Vec3; facing: Vec3; }

// Default seat layout from rectangle table half-extents. 8 seats walking CCW
// (viewed from above) starting at front-right: 3 across the +Z edge, 1 on -X,
// 3 across the -Z edge, 1 on +X. Used to seed `TableComponent.state.seats` on
// first spawn; subsequent edits replace the default values in place.
export function computeSeatLayout(bounds: { halfWidth: number; halfDepth: number }): SeatPose[] {
  const hx = bounds.halfWidth;
  const hz = bounds.halfDepth;
  return [
    { position: { x:  hx / 2, y: 0, z:  hz     }, facing: { x:  0, y: 0, z: -1 } },
    { position: { x:  0,      y: 0, z:  hz     }, facing: { x:  0, y: 0, z: -1 } },
    { position: { x: -hx / 2, y: 0, z:  hz     }, facing: { x:  0, y: 0, z: -1 } },
    { position: { x: -hx,     y: 0, z:  0      }, facing: { x:  1, y: 0, z:  0 } },
    { position: { x: -hx / 2, y: 0, z: -hz     }, facing: { x:  0, y: 0, z:  1 } },
    { position: { x:  0,      y: 0, z: -hz     }, facing: { x:  0, y: 0, z:  1 } },
    { position: { x:  hx / 2, y: 0, z: -hz     }, facing: { x:  0, y: 0, z:  1 } },
    { position: { x:  hx,     y: 0, z:  0      }, facing: { x: -1, y: 0, z:  0 } },
  ];
}

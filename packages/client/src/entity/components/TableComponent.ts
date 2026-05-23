// Marker component for the singleton Table entity. Carries seat-pose state
// (8 seats; defaults populated on first spawn from current table bounds) and
// continues to discriminate the Table from every other scene entity. Locking
// enforcement (no-despawn / no-spawn-duplicate / no-drag / no-gizmo / no-delete)
// keys on `entity.hasComponent(TableComponent)` rather than on a magic GUID
// check, so future fixture-class entities can reuse the pattern.

import { EntityComponent, type SpawnContext } from '../EntityComponent';
import { MeshComponent } from './MeshComponent';
import { TransformComponent } from './TransformComponent';
import { defaultSeatStates, type SeatState } from '../../seats/SeatPoseState';
import {
  DEFAULT_TABLE_HALF_WIDTH,
  DEFAULT_TABLE_HALF_DEPTH,
} from '../tableEntity';

export interface TableState {
  seats?: SeatState[];
}

export class TableComponent extends EntityComponent<TableState> {
  static typeId   = 'table';
  static label    = 'Table';
  static requires = ['mesh', 'transform'] as const;

  onSpawn(_ctx: SpawnContext): void {
    if (!Array.isArray(this.state.seats) || this.state.seats.length === 0) {
      this.state.seats = defaultSeatStates(this.computeBounds());
    }
  }

  onPropertiesChanged(_changed: Partial<TableState>): void {}

  private computeBounds(): { halfWidth: number; halfDepth: number } {
    const mesh      = this.entity?.getComponent(MeshComponent);
    const transform = this.entity?.getComponent(TransformComponent);
    if (!mesh || !transform) {
      return { halfWidth: DEFAULT_TABLE_HALF_WIDTH, halfDepth: DEFAULT_TABLE_HALF_DEPTH };
    }
    const [hx, _hy, hz] = mesh.halfExtents();
    const [sx, _sy, sz] = transform.state.scale;
    return { halfWidth: hx * sx, halfDepth: hz * sz };
  }
}

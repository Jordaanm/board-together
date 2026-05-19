// Host-side handler for drag input streamed from guests. Slice #5 reworks
// this around the v2 entity model: ownership is `entity.heldBy`, set by
// HoldService. drag-move messages only take effect while the sender's seat
// matches the entity's heldBy.

import { type SceneImpl } from '../entity/Scene';
import { PhysicsComponent } from '../entity/components/PhysicsComponent';
import { type GuestInputMessage } from '../net/SceneState';
import { type SeatIndex } from '../seats/SeatLayout';
import { type HoldService } from '../entity/HoldService';
import { type DeckService } from '../entity/DeckService';

export class GuestInputHandler {
  private decks: DeckService | null = null;

  constructor(
    private readonly hold: HoldService,
    private readonly getPeerSeat: (peerId: string) => SeatIndex | null,
    private readonly scene: SceneImpl,
  ) {}

  // World wires this on host construction. Tests omit it; releasePeer skips
  // the inspect-lock cleanup when null.
  setDeckService(decks: DeckService): void {
    this.decks = decks;
  }

  handleMessage(peerId: string, msg: GuestInputMessage) {
    if (msg.type !== 'guest-drag-move') return;
    const seat = this.getPeerSeat(peerId);
    if (seat === null) return;
    const entity = this.scene.getEntity(msg.objectId);
    if (!entity || entity.heldBy !== seat) return;
    const body = entity.getComponent(PhysicsComponent)?.body;
    if (!body) return;
    body.position.set(msg.px, msg.py, msg.pz);
    body.velocity.setZero();
    body.angularVelocity.setZero();
  }

  // Peer disconnect: drop every hold owned by the leaving seat, and clear any
  // deck inspect-locks they were holding. Issue #2 of
  // planning/issues--deck-inspect.md.
  releasePeer(peerId: string) {
    const seat = this.getPeerSeat(peerId);
    if (seat === null) return;
    this.hold.releaseAllForSeat(seat);
    this.decks?.clearSearchLocksForSeat(seat);
  }
}

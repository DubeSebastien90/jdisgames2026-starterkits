import * as MessageProtocol from "../client/message_protocol";
import { IMover } from "./imover";

/**
 * Walks straight at the target and, when a move is refused, sidesteps
 * perpendicular for a few tiles before carrying on. Reaches further each time
 * it is blocked again, so it can round obstacles longer than one leg.
 *
 * Superseded by PathfindingMover, which plans around obstacles instead of
 * discovering them by collision. Kept because it needs no tile vision at all,
 * so it still works where the map is unknown. Swap it in with:
 *
 *   private readonly mover: IMover = new SidestepMover();
 */
export class SidestepMover implements IMover {
  public readonly name = "sidestep";

  private static readonly DETOUR_STEPS = 5;
  private static readonly MAX_DETOUR_ATTEMPTS = 4;

  private posBeforeMove: MessageProtocol.Position | null = null;
  private lastMoveTarget: MessageProtocol.Position | null = null;
  private refused = false;
  private detourRemaining = 0;
  private detourDelta: { x: number; y: number } | null = null;
  private detourSide = 1;
  private detourAttempts = 0;

  public get lastMoveRefused(): boolean {
    return this.refused;
  }

  public observe(
    _state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): void {
    const from = this.posBeforeMove;
    const to = this.lastMoveTarget;
    this.posBeforeMove = null;
    this.lastMoveTarget = null;
    this.refused = false;

    if (!from || !to) {
      return;
    }

    if (pos.X !== from.X || pos.Y !== from.Y) {
      // Moving normally again, so the obstacle is behind us.
      if (this.detourRemaining === 0) {
        this.detourAttempts = 0;
      }
      return;
    }

    this.refused = true;

    // Wedged during the sidestep itself: back out the other way.
    if (this.detourRemaining > 0 && this.detourDelta) {
      this.detourDelta = { x: -this.detourDelta.x, y: -this.detourDelta.y };
      this.detourRemaining = SidestepMover.DETOUR_STEPS;
      return;
    }

    // Blocked again right after a detour means the obstacle is longer than we
    // thought, so keep going the same way and reach further each time.
    this.detourAttempts = Math.min(
      this.detourAttempts + 1,
      SidestepMover.MAX_DETOUR_ATTEMPTS,
    );

    const wasHorizontal = to.X !== from.X;
    this.detourDelta = wasHorizontal
      ? { x: 0, y: this.detourSide }
      : { x: this.detourSide, y: 0 };
    this.detourRemaining = SidestepMover.DETOUR_STEPS * this.detourAttempts;
  }

  public step(
    _state: MessageProtocol.GameState,
    from: MessageProtocol.Position,
    to: MessageProtocol.Position,
  ): MessageProtocol.MoveAction | null {
    // A detour in progress outranks the direct route until it finishes.
    if (this.detourRemaining > 0 && this.detourDelta) {
      this.detourRemaining--;
      const side = this.detourDelta;
      return this.move(
        from,
        new MessageProtocol.Position(from.X + side.x, from.Y + side.y),
      );
    }

    if (from.X === to.X && from.Y === to.Y) {
      return null;
    }

    const deltaX = to.X - from.X;
    const deltaY = to.Y - from.Y;

    return this.move(
      from,
      deltaX !== 0
        ? new MessageProtocol.Position(from.X + Math.sign(deltaX), from.Y)
        : new MessageProtocol.Position(from.X, from.Y + Math.sign(deltaY)),
    );
  }

  private move(
    from: MessageProtocol.Position,
    to: MessageProtocol.Position,
  ): MessageProtocol.MoveAction {
    this.posBeforeMove = from;
    this.lastMoveTarget = to;
    return new MessageProtocol.MoveAction(to);
  }
}

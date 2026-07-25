import { MoveAction, Position } from "../../client/message_protocol";
import { MoveStrategy } from "../../core/contracts";
import { BotContext, samePosition } from "../../core/types";
import { BotMemory } from "../../memory/bot_memory";

/**
 * The dumbest useful mover: one tile per tick, straight at the target.
 * Diagonal when both axes still differ, which keeps a traced ring round.
 *
 * No pathfinding, no obstacle avoidance — swap in a smarter MoveStrategy later
 * and nothing above this layer changes.
 */
export class StepTowards implements MoveStrategy {
  public readonly name = "StepTowards";

  public step(ctx: BotContext, target: Position, _memory: BotMemory): MoveAction | null {
    const from = ctx.self.Position;
    if (samePosition(from, target)) {
      return null;
    }

    return new MoveAction(
      new Position(from.X + Math.sign(target.X - from.X), from.Y + Math.sign(target.Y - from.Y)),
    );
  }
}

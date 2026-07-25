import { DepositToBaseAction } from "../../client/message_protocol";
import { GoalDecision, GoalStrategy, MoveStrategy } from "../../core/contracts";
import { BotContext, distance, samePosition } from "../../core/types";
import { BotMemory } from "../../memory/bot_memory";
import { baseTarget, inventoryUnits } from "../../util/world";
import { StepTowards } from "../move/step_towards";

/** Ticks of not moving before we try depositing from where we stand. */
const STUCK_LIMIT = 3;

/**
 * Walks home and empties the inventory into base storage.
 *
 * `arrived === true` once the inventory is empty, so the agent will not interrupt
 * a delivery halfway.
 */
export class ReturnToBase implements GoalStrategy {
  public readonly name = "ReturnToBase";

  private mover: MoveStrategy = new StepTowards();

  public decide(ctx: BotContext, memory: BotMemory): GoalDecision {
    const base = ctx.state.Base;
    if (base === null) {
      return { action: null, arrived: true }; // no base known -> nothing to do here
    }

    if (inventoryUnits(ctx.self) === 0) {
      return { action: null, arrived: true }; // delivered
    }

    const target = baseTarget(base);
    const onTarget = samePosition(ctx.self.Position, target);

    // Deposit once we're on the tile, or from just outside if the footprint turns
    // out to be solid and we physically cannot step in.
    if (onTarget || (memory.stuckFor() >= STUCK_LIMIT && distance(ctx.self.Position, target) <= 2)) {
      memory.clearStuck();
      return { action: new DepositToBaseAction(), arrived: false };
    }

    return { action: this.mover.step(ctx, target, memory), arrived: false };
  }
}

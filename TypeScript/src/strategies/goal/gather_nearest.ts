import { GatherNodeAction } from "../../client/message_protocol";
import { GoalDecision, GoalStrategy, MoveStrategy } from "../../core/contracts";
import { BotContext, distance } from "../../core/types";
import { BotMemory } from "../../memory/bot_memory";
import { inventoryUnits, isInventoryFull, nearestGatherable } from "../../util/world";
import { StepTowards } from "../move/step_towards";

/** Chebyshev distance at which we can reach a node: our tile or any neighbour. */
const GATHER_RANGE = 1;

/** Gather ticks with no item gained before we assume the node is a dud. */
const NO_PICKUP_LIMIT = 4;

/** Ticks of not moving before we give up walking to this node. */
const STUCK_LIMIT = 4;

/**
 * Walks to the closest visible resource and gathers it until we are full or it
 * runs dry.
 *
 * `arrived === true` means "done with this trip" — full, nothing left to gather,
 * or nothing visible — which is the agent's cue to reselect (normally a return
 * trip to the base).
 */
export class GatherNearest implements GoalStrategy {
  public readonly name = "GatherNearest";

  // ---- implementation memory: which node this trip committed to ----
  private mover: MoveStrategy = new StepTowards();
  private targetResourceId: number | null = null;

  public decide(ctx: BotContext, memory: BotMemory): GoalDecision {
    if (isInventoryFull(ctx.self) || memory.isPackFull()) {
      return this.done(memory);
    }

    // Stay committed to the chosen node while it is still valid, so we don't
    // flip-flop between two nodes at equal distance and never reach either.
    let target = ctx.state.VisibleResources.find(
      (resource) =>
        resource.Id === this.targetResourceId &&
        resource.CurrentAmount > 0 &&
        !memory.isResourceBlocked(resource.Id, ctx.tick),
    );

    if (target === undefined) {
      target = nearestGatherable(ctx, memory) ?? undefined;
      if (target === undefined) {
        return this.done(memory); // nothing to gather -> let the agent explore
      }

      this.targetResourceId = target.Id;
      memory.clearGatherProgress();
    }

    if (distance(ctx.self.Position, target.Position) > GATHER_RANGE) {
      if (memory.stuckFor() >= STUCK_LIMIT) {
        // Can't get closer — blacklist it and try another node next tick.
        memory.blockResource(target.Id, ctx.tick);
        memory.clearStuck();
        this.targetResourceId = null;
        return { action: null, arrived: false };
      }

      return { action: this.mover.step(ctx, target.Position, memory), arrived: false };
    }

    // In range. Ask for items and watch the inventory to see if it worked.
    memory.noteGatherAttempt(inventoryUnits(ctx.self));

    if (memory.noPickupFor() >= NO_PICKUP_LIMIT) {
      // Nothing is arriving. An empty pack that gains nothing is the node's
      // fault; a loaded one has almost certainly hit a capacity limit, so leave
      // the node alone and go deposit.
      if (inventoryUnits(ctx.self) === 0) {
        memory.blockResource(target.Id, ctx.tick);
      } else {
        memory.markPackFull();
      }

      return this.done(memory);
    }

    return { action: new GatherNodeAction(target.Position), arrived: false };
  }

  private done(memory: BotMemory): GoalDecision {
    this.targetResourceId = null;
    memory.clearGatherProgress();
    return { action: null, arrived: true };
  }
}

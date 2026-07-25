// ⚠ SHARED — this is the brain: it holds memory and is the only place that selects.

import { ActionBase, GameState, RespawnAction } from "../client/message_protocol";
import { GoalStrategy } from "../core/contracts";
import { BotContext } from "../core/types";
import { BotMemory } from "../memory/bot_memory";
import { GatherNearest } from "../strategies/goal/gather_nearest";
import { PatrolCircle } from "../strategies/goal/patrol_circle";
import { ReturnToBase } from "../strategies/goal/return_to_base";
import { inventoryUnits, isInventoryFull, nearestGatherable } from "../util/world";

export class BotAgent {
  // ----- agent memory: created once, never replaced, survives every swap -----
  private readonly memory = new BotMemory();

  // ----- strategy instances: built once, reused (keeps their caches warm) -----
  private readonly goals = {
    gather: new GatherNearest(),
    deliver: new ReturnToBase(),
    patrol: new PatrolCircle(5, 12),
  };

  // ----- current implementations -----
  private goal: GoalStrategy = this.goals.gather;
  private lastArrived = true;

  public tick(state: GameState): ActionBase | null {
    const self = state.Bot;
    if (self === null) {
      return null;
    }

    // Dead bots do not walk. Respawn preempts everything.
    const me = state.VisiblePlayers.find((player) => player.IsSelf);
    if (me !== undefined && !me.Alive) {
      return me.RespawnRemainingTicks <= 0 ? new RespawnAction() : null;
    }

    // Keep memory honest against ground truth before anyone reads it.
    this.memory.rememberAnchor(self.Position);
    this.memory.observePosition(self.Position);
    this.memory.observeInventory(inventoryUnits(self));

    const ctx: BotContext = { state, self, tick: state.CurrentTick };

    this.selectGoal(ctx);

    const { action, arrived } = this.goal.decide(ctx, this.memory);
    this.lastArrived = arrived;

    return action;
  }

  /** The AGENT decides WHAT to run; the strategy makes the actual decision. */
  private selectGoal(ctx: BotContext): void {
    // 1. emergencies preempt even an unfinished goal: a full pack cannot gather,
    //    so head home immediately rather than finishing the current trip.
    if (this.isLoaded(ctx) && this.goal.name !== this.goals.deliver.name) {
      this.goal = this.goals.deliver;
      return;
    }

    // 2. don't interrupt an unfinished commitment.
    if (!this.lastArrived) {
      return;
    }

    // 3. finished -> reselect.
    this.goal = this.chooseNextGoal(ctx);
  }

  /** Carrying all we can — by slot count, or because items stopped arriving. */
  private isLoaded(ctx: BotContext): boolean {
    return isInventoryFull(ctx.self) || this.memory.isPackFull();
  }

  private chooseNextGoal(ctx: BotContext): GoalStrategy {
    if (this.isLoaded(ctx)) {
      return this.goals.deliver;
    }

    if (nearestGatherable(ctx, this.memory) !== null) {
      return this.goals.gather;
    }

    // Nothing in sight: drop off whatever we already carry, otherwise go look
    // around — the patrol circle doubles as our explore behaviour.
    return inventoryUnits(ctx.self) > 0 ? this.goals.deliver : this.goals.patrol;
  }

  public currentStrategies(): { goal: string } {
    return { goal: this.goal.name };
  }
}

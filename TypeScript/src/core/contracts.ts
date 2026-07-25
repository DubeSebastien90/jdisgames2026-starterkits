// ⚠ SHARED + STABLE — changing this ripples through every strategy.

import { ActionBase, Position } from "../client/message_protocol";
import { BotMemory } from "../memory/bot_memory";
import { BotContext } from "./types";

/**
 * A goal owns a destination and reports whether it is done with it.
 * `arrived === true` tells the agent it may reselect a different goal.
 */
export interface GoalDecision {
  readonly action: ActionBase | null;
  readonly arrived: boolean;
}

/** GOAL layer: decides WHERE to go, delegates the step to a MoveStrategy. */
export interface GoalStrategy {
  readonly name: string;
  decide(ctx: BotContext, memory: BotMemory): GoalDecision;
}

/** MOVE layer: pure pather. Told WHERE, only answers HOW to step. */
export interface MoveStrategy {
  readonly name: string;
  step(ctx: BotContext, target: Position, memory: BotMemory): ActionBase | null;
}

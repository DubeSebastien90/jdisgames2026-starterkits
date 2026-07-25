import { ActionBase, GameState } from "../client/message_protocol";

/**
 * One bot's brain. A behaviour owns its own state across ticks, so every bot
 * gets its own instance (see TeamController).
 */
export interface IBehaviour {
  /** Shown in the logs so you can tell which bot is doing what. */
  readonly name: string;

  /** Called once per tick. Return null to do nothing this tick. */
  getNextAction(state: GameState): ActionBase | null;
}

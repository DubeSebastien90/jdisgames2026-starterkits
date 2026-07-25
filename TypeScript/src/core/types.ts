import { GameState, PlayerInfo, Position } from "../client/message_protocol";

/**
 * Everything a strategy needs about "right now", assembled once per tick by the
 * agent. `self` is non-null: the agent handles the no-bot case before building it.
 */
export interface BotContext {
  readonly state: GameState;
  readonly self: PlayerInfo;
  readonly tick: number;
}

export function samePosition(a: Position, b: Position): boolean {
  return a.X === b.X && a.Y === b.Y;
}

/** Chebyshev distance: number of steps when diagonals are allowed. */
export function distance(a: Position, b: Position): number {
  return Math.max(Math.abs(a.X - b.X), Math.abs(a.Y - b.Y));
}

import { GameState, MoveAction, Position } from "../client/message_protocol";

/**
 * How a bot takes one step toward somewhere. Behaviours decide *where* to go;
 * a mover decides *how* to get there, so every behaviour shares the same
 * navigation instead of re-inventing it.
 *
 * Movers keep their own scratch state (paths, blocked tiles), so give each bot
 * its own instance.
 */
export interface IMover {
  readonly name: string;

  /**
   * True when last tick's move was refused, i.e. we did not actually move.
   * Behaviours use this to notice they are wedged.
   */
  readonly lastMoveRefused: boolean;

  /** Call once per tick, before step(), so the mover can see what happened. */
  observe(state: GameState, pos: Position): void;

  /** One tile toward `to`. Null when there is nowhere useful to step. */
  step(state: GameState, from: Position, to: Position): MoveAction | null;
}

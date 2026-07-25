import * as MessageProtocol from "../client/message_protocol";
import { IBehaviour } from "./ibehaviour";

/**
 * Walk up (-Y) forever, one tile per tick. No pathfinding, no goal: a probe
 * for seeing what is out that way and how far the bot gets before something
 * stops it.
 *
 * Y grows downwards on this map, which is why up is -1.
 */
export class GoUpBehaviour implements IBehaviour {
  public readonly name = "go-up";

  /** Ticks between "still going" reports, so the log stays readable. */
  private static readonly LOG_EVERY = 10;

  private tag = "bot";
  private lastPosition: MessageProtocol.Position | null = null;
  private blockedTicks = 0;

  public getNextAction(
    state: MessageProtocol.GameState,
  ): MessageProtocol.ActionBase | null {
    if (!state.Bot) {
      return null;
    }

    this.tag = state.Bot.BotType || "bot";
    const pos = state.Bot.Position;

    // The move is sent regardless; this only reports whether it landed.
    if (this.lastPosition && this.lastPosition.X === pos.X && this.lastPosition.Y === pos.Y) {
      this.blockedTicks++;
      console.log(`[${this.tag}] Blocked going up at ${pos.X},${pos.Y} for ${this.blockedTicks} tick(s).`);
    } else {
      if (this.blockedTicks > 0) {
        console.log(`[${this.tag}] Moving again, now at ${pos.X},${pos.Y}.`);
      }
      this.blockedTicks = 0;
      if (state.CurrentTick % GoUpBehaviour.LOG_EVERY === 0) {
        console.log(`[${this.tag}] Going up, at ${pos.X},${pos.Y}.`);
      }
    }
    this.lastPosition = pos;

    return new MessageProtocol.MoveAction(new MessageProtocol.Position(pos.X, pos.Y - 1));
  }
}

import * as MessageProtocol from "../client/message_protocol";
import { IBehaviour } from "./ibehaviour";

/**
 * Do nothing, forever. Stands where it spawned and never sends an action.
 *
 * There is no HoldStill *action* in the protocol and there should not be: the
 * client sends nothing at all when a behaviour returns null (see GameClient), so
 * "no action" already means "stand there". Inventing an action type for it would
 * put a word on the wire the server does not know.
 *
 * Worth having as a behaviour anyway: park one bot to watch what the other does
 * without two logs interleaving, keep a bot out of a teammate's way while
 * testing, or hold a tile that a companion route wants kept clear.
 */
export class HoldStillBehaviour implements IBehaviour {
  public readonly name = "hold-still";

  /** Ticks between "still here" reports, so an idle bot is not a silent one. */
  private static readonly LOG_EVERY = 50;

  private tag = "bot";
  private lastLogTick: number | null = null;

  public getNextAction(
    state: MessageProtocol.GameState,
  ): MessageProtocol.ActionBase | null {
    if (!state.Bot) {
      return null;
    }

    this.tag = state.Bot.BotType || "bot";

    if (
      this.lastLogTick === null ||
      state.CurrentTick - this.lastLogTick >= HoldStillBehaviour.LOG_EVERY
    ) {
      this.lastLogTick = state.CurrentTick;
      const pos = state.Bot.Position;
      console.log(`[${this.tag}] Holding still at ${pos.X},${pos.Y}.`);
    }

    return null;
  }
}

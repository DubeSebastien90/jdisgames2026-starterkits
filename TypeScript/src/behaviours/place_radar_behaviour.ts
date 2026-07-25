import * as MessageProtocol from "../client/message_protocol";
import { IBehaviour } from "./ibehaviour";

/**
 * Place a radar exactly where the bot is standing, then idle.
 */
export class PlaceRadarBehaviour implements IBehaviour {
  public readonly name = "place-radar";

  private placed = false;
  private tag = "bot";

  public getNextAction(
    state: MessageProtocol.GameState,
  ): MessageProtocol.ActionBase | null {
    if (!state.Bot) {
      return null;
    }

    this.tag = state.Bot.BotType || "bot";

    if (this.placed) {
      return null;
    }

    const pos = state.Bot.Position;
    console.log(`[${this.tag}] Placing radar at ${pos.X},${pos.Y}.`);
    this.placed = true;
    return new MessageProtocol.PlaceRadarAction(pos);
  }
}

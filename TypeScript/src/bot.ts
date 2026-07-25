import * as MessageProtocol from "./client/message_protocol";
import { IBot } from "./bot_logic/ibot";
import { BotAgent } from "./agent/bot_agent";

export class Bot implements IBot {
  // EDIT THIS FOR YOUR OWN BOT TOKEN
  public static readonly TOKEN = "BOTA-5a3y-D2Jk-C5yk";

  // The agent lives across ticks — that is where memory and the active strategies are.
  private readonly agent = new BotAgent();

  public getNextAction(
    state: MessageProtocol.GameState,
  ): MessageProtocol.ActionBase | null {
    return this.agent.tick(state);
  }
}

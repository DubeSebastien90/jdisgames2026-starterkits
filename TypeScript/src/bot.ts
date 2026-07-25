import * as MessageProtocol from "./client/message_protocol";
import { IBot } from "./bot_logic/ibot";

export class Bot implements IBot {
  // EDIT THIS FOR YOUR OWN BOT TOKEN
  public static readonly TOKEN = "BOTA-5a3y-D2Jk-C5yk";
  public static readonly TOKEN_B = "BOTB-5a3y-D2Jk-C5yk";

  // 0-4 = 5 steps left, 5-9 = 5 steps right, then repeat
  private step = 0;

  public getNextAction(
    state: MessageProtocol.GameState,
  ): MessageProtocol.ActionBase | null {
    if (!state.Bot) {
      return null;
    }

    const dx = this.step < 5 ? -1 : 1;
    this.step = (this.step + 1) % 10;

    return new MessageProtocol.MoveAction(
      new MessageProtocol.Position(state.Bot.Position.X + dx, state.Bot.Position.Y),
    );
  }
}

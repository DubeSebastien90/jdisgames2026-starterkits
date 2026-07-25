import * as MessageProtocol from "./client/message_protocol";
import { IBot } from "./bot_logic/ibot";

export class Bot implements IBot {
  // EDIT THIS FOR YOUR OWN BOT TOKEN
  public static readonly TOKEN = "BOTA-5a3y-D2Jk-C5yk";
  public static readonly TOKEN_B = "BOTB-5a3y-D2Jk-C5yk";

  // Locked on the first resource we ever see; null while still walking left.
  private target: MessageProtocol.Position | null = null;
  private parked = false;

  public getNextAction(
    state: MessageProtocol.GameState,
  ): MessageProtocol.ActionBase | null {
    if (this.parked || !state.Bot) {
      return null;
    }

    const pos = state.Bot.Position;

    if (!this.target) {
      this.target = this.nearestResource(pos, state.VisibleResources);
    }

    // Nothing spotted yet: keep heading left forever.
    if (!this.target) {
      return new MessageProtocol.MoveAction(
        new MessageProtocol.Position(pos.X - 1, pos.Y),
      );
    }

    const deltaX = this.target.X - pos.X;
    const deltaY = this.target.Y - pos.Y;

    // Already next to it (including diagonally): stop for good.
    if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) <= 1) {
      this.parked = true;
      console.log(`[BOT] Parked next to resource at ${this.target.X},${this.target.Y}`);
      return null;
    }

    // One tile per tick, closing X first then Y.
    return new MessageProtocol.MoveAction(
      deltaX !== 0
        ? new MessageProtocol.Position(pos.X + Math.sign(deltaX), pos.Y)
        : new MessageProtocol.Position(pos.X, pos.Y + Math.sign(deltaY)),
    );
  }

  private nearestResource(
    from: MessageProtocol.Position,
    resources: MessageProtocol.Resource[],
  ): MessageProtocol.Position | null {
    let best: MessageProtocol.Position | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const resource of resources) {
      const distance =
        Math.abs(resource.Position.X - from.X) + Math.abs(resource.Position.Y - from.Y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = resource.Position;
      }
    }

    return best;
  }
}

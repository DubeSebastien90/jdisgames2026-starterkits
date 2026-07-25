import * as MessageProtocol from "../client/message_protocol";
import { IBehaviour } from "./ibehaviour";

/**
 * Walk straight back to the base and stay there.
 */
export class ReturnToBaseBehaviour implements IBehaviour {
  public readonly name = "return-to-base";

  private tag = "bot";

  public getNextAction(
    state: MessageProtocol.GameState,
  ): MessageProtocol.ActionBase | null {
    if (!state.Bot || !state.Base) {
      return null;
    }

    this.tag = state.Bot.BotType || "bot";
    const pos = state.Bot.Position;
    const base = state.Base;

    if (this.atBase(pos, base)) {
      return null;
    }

    return this.stepToward(pos, base.Position);
  }

  private atBase(pos: MessageProtocol.Position, base: MessageProtocol.BaseInfo): boolean {
    const w = Math.max(base.Width, 1);
    const h = Math.max(base.Height, 1);
    return (
      pos.X >= base.Position.X - 1 &&
      pos.X <= base.Position.X + w &&
      pos.Y >= base.Position.Y - 1 &&
      pos.Y <= base.Position.Y + h
    );
  }

  private stepToward(
    from: MessageProtocol.Position,
    to: MessageProtocol.Position,
  ): MessageProtocol.MoveAction {
    const dx = to.X - from.X;
    const dy = to.Y - from.Y;
    const next =
      Math.abs(dx) >= Math.abs(dy)
        ? new MessageProtocol.Position(from.X + Math.sign(dx), from.Y)
        : new MessageProtocol.Position(from.X, from.Y + Math.sign(dy));
    return new MessageProtocol.MoveAction(next);
  }
}

import * as MessageProtocol from "../client/message_protocol";
import { IBehaviour } from "./ibehaviour";

/**
 * Place a radar one tile to the right of where the bot is standing, then idle.
 */
export class PlaceRadarBehaviour implements IBehaviour {
  public readonly name = "place-radar";

  private placed = false;
  private tag = "bot";
  private static readonly OFFSETS = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
  ];
  private attempt = 0;

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

    // Check if a radar appeared nearby — means a previous attempt worked.
    if (this.attempt > 0) {
      const pos = state.Bot.Position;
      for (const s of state.VisibleStructures) {
        if (s.Type === "Radar" && s.IsAlly && this.chebyshev(pos, s.Position) <= 2) {
          console.log(`[${this.tag}] Radar confirmed at ${s.Position.X},${s.Position.Y}.`);
          this.placed = true;
          return null;
        }
      }
    }

    if (this.attempt >= PlaceRadarBehaviour.OFFSETS.length) {
      console.log(`[${this.tag}] All radar placement attempts failed.`);
      this.placed = true;
      return null;
    }

    const pos = state.Bot.Position;
    const offset = PlaceRadarBehaviour.OFFSETS[this.attempt];
    const target = new MessageProtocol.Position(pos.X + offset.x, pos.Y + offset.y);
    console.log(`[${this.tag}] Placing radar at ${target.X},${target.Y} (attempt ${this.attempt + 1}).`);
    this.attempt++;
    return new MessageProtocol.PlaceRadarAction(target);
  }

  private chebyshev(a: MessageProtocol.Position, b: MessageProtocol.Position): number {
    return Math.max(Math.abs(a.X - b.X), Math.abs(a.Y - b.Y));
  }
}

import * as MessageProtocol from "../client/message_protocol";
import { IBehaviour } from "./ibehaviour";
import { IMover } from "../movement/imover";
import { PathfindingMover } from "../movement/pathfinding_mover";

type Phase = "withdraw" | "move" | "send";

/**
 * Exploit the companion badge mechanic:
 *   1. Withdraw all available items from base storage.
 *   2. Walk one step to the right of the base.
 *   3. Send companions (each takes one stack and walks back to base).
 *   4. When inventory is empty, go back to step 1.
 */
export class CompanionFarmerBehaviour implements IBehaviour {
  public readonly name = "companion-farmer";

  /** Shared navigation: routes around trees, hulls and other bots. */
  private readonly mover: IMover = new PathfindingMover();

  private phase: Phase = "withdraw";
  private tag = "bot";
  private standbyPos: MessageProtocol.Position | null = null;

  public getNextAction(state: MessageProtocol.GameState): MessageProtocol.ActionBase | null {
    if (!state.Bot || !state.Base || !state.Team) {
      return null;
    }

    this.tag = state.Bot.BotType || "bot";
    this.mover.observe(state, state.Bot.Position);

    const pos = state.Bot.Position;
    const base = state.Base;

    if (!this.standbyPos) {
      // One tile to the right of the base's right edge.
      this.standbyPos = new MessageProtocol.Position(
        base.Position.X + Math.max(base.Width, 1) + 1,
        base.Position.Y,
      );
      console.log(`[${this.tag}] Standby position set to ${this.standbyPos.X},${this.standbyPos.Y}`);
    }

    if (this.phase === "withdraw") {
      return this.doWithdraw(state, pos, base, state.Bot);
    }
    if (this.phase === "move") {
      return this.doMove(state, pos, this.standbyPos);
    }
    return this.doSend(state.Bot, state.Team);
  }

  // ─── Phase: withdraw ────────────────────────────────────────────────────────

  private doWithdraw(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    base: MessageProtocol.BaseInfo,
    bot: MessageProtocol.PlayerInfo,
  ): MessageProtocol.ActionBase | null {
    if (!this.onBase(pos, base)) {
      return this.mover.step(state, pos, base.Position);
    }

    const freeSlots = bot.Slots > 0 ? bot.Slots - bot.Inventory.length : 10 - bot.Inventory.length;

    if (freeSlots <= 0 || base.Inventory.length === 0) {
      console.log(
        `[${this.tag}] Done withdrawing (freeSlots=${freeSlots}, baseItems=${base.Inventory.length}). Moving to standby.`,
      );
      this.phase = "move";
      return null;
    }

    const item = base.Inventory[0];
    console.log(`[${this.tag}] Withdrawing ${item.ItemName} x${item.Quantity} from base.`);
    return new MessageProtocol.WithdrawFromBaseAction(item.ItemName, item.Quantity);
  }

  // ─── Phase: move ────────────────────────────────────────────────────────────

  private doMove(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    target: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    if (pos.X === target.X && pos.Y === target.Y) {
      console.log(`[${this.tag}] At standby, starting companion sends.`);
      this.phase = "send";
      return null;
    }
    return this.mover.step(state, pos, target);
  }

  // ─── Phase: send ────────────────────────────────────────────────────────────

  private doSend(
    bot: MessageProtocol.PlayerInfo,
    team: MessageProtocol.TeamInfo,
  ): MessageProtocol.ActionBase | null {
    const carried = bot.Inventory.reduce((sum, s) => sum + s.Quantity, 0);

    if (carried === 0) {
      console.log(`[${this.tag}] Inventory empty, heading back to base.`);
      this.phase = "withdraw";
      return null;
    }

    if (team.CompanionNumber >= team.CompanionSlots) {
      // All slots occupied — wait for companions to return and free up.
      return null;
    }

    console.log(
      `[${this.tag}] Sending companion (${carried} items carried, ${team.CompanionNumber}/${team.CompanionSlots} slots used).`,
    );
    return new MessageProtocol.SendCompanionAction();
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** True if the bot is inside the base rectangle. */
  private onBase(pos: MessageProtocol.Position, base: MessageProtocol.BaseInfo): boolean {
    const w = Math.max(base.Width, 1);
    const h = Math.max(base.Height, 1);
    return (
      pos.X >= base.Position.X &&
      pos.X < base.Position.X + w &&
      pos.Y >= base.Position.Y &&
      pos.Y < base.Position.Y + h
    );
  }

}

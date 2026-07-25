import * as MessageProtocol from "../client/message_protocol";
import { IBehaviour } from "./ibehaviour";
import { IMover } from "../movement/imover";
import { PathfindingMover } from "../movement/pathfinding_mover";
import { BaseGeometry } from "../world/base_geometry";

type Phase = "withdraw" | "move" | "send";

/** A list of candidate tiles walked in order, moving on when one is a dead end. */
interface SpotPlan {
  spots: MessageProtocol.Position[];
  index: number;
  stuckTicks: number;
}

/**
 * Exploit the companion badge mechanic:
 *   1. Withdraw all available items from base storage.
 *   2. Walk one step off the side of the base.
 *   3. Send companions (each takes one stack and walks back to base).
 *   4. When inventory is empty, go back to step 1.
 */
export class CompanionFarmerBehaviour implements IBehaviour {
  public readonly name = "companion-farmer";

  // Refused moves in a row before we decide a candidate tile is unreachable and
  // try the next one. The hull blocks a lot of tiles, and the server does not
  // tell us which reading of BaseInfo.Position is the right one.
  private static readonly STUCK_TICKS = 6;
  // Touching the hull is close enough to withdraw: base actions have been seen
  // to succeed from a tile just outside it, and the inside is not walkable.
  private static readonly WITHDRAW_RANGE = 1;
  // Withdraw requests that changed nothing before we accept it is not working
  // from here. Without this a refused withdraw is silent and repeats for ever.
  private static readonly WITHDRAW_TRIES = 5;

  /** Shared navigation: routes around trees, hulls and other bots. */
  private readonly mover: IMover = new PathfindingMover();

  private phase: Phase = "withdraw";
  private tag = "bot";
  private withdrawPlan: SpotPlan | null = null;
  private standbyPlan: SpotPlan | null = null;
  private withdrawTries = 0;
  private lastCarried = 0;
  /** Set once a full-stack request has been refused, see doWithdraw. */
  private oneAtATime = false;

  public getNextAction(state: MessageProtocol.GameState): MessageProtocol.ActionBase | null {
    if (!state.Bot || !state.Base || !state.Team) {
      return null;
    }

    this.tag = state.Bot.BotType || "bot";
    this.mover.observe(state, state.Bot.Position);

    const pos = state.Bot.Position;
    const base = state.Base;

    if (!this.withdrawPlan) {
      // Same candidates the gatherer deposits on, for the same reason: we do
      // not know which tile the storage actually answers from.
      this.withdrawPlan = this.plan(BaseGeometry.interiorTiles(base));
      this.standbyPlan = this.plan(BaseGeometry.perimeterTiles(base, "right"));
      console.log(
        `[${this.tag}] Base ${base.Position.X},${base.Position.Y} ${base.Width}x${base.Height}: ` +
          `standby ${this.describe(this.standbyPlan)}, storage ${this.describe(this.withdrawPlan)}.`,
      );
    }

    if (this.phase === "withdraw") {
      return this.doWithdraw(state, pos, base, state.Bot);
    }
    if (this.phase === "move") {
      return this.doMove(state, pos, base);
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
    if (
      BaseGeometry.distanceTo(base, pos) > CompanionFarmerBehaviour.WITHDRAW_RANGE
    ) {
      return this.mover.step(state, pos, this.target(state, this.withdrawPlan!));
    }

    const carried = this.carriedCount(bot);
    const freeSlots = bot.Slots > 0 ? bot.Slots - bot.Inventory.length : 10 - bot.Inventory.length;

    if (freeSlots <= 0 || base.Inventory.length === 0) {
      // Anything at all is enough to send a companion, since one carries a
      // single item by default. Only an empty pack is worth complaining about.
      console.log(
        `[${this.tag}] Done withdrawing ${carried} (freeSlots=${freeSlots}, ` +
          `baseItems=${base.Inventory.length}). Moving to standby.`,
      );
      this.phase = "move";
      return null;
    }

    // Something landed in the pack, so this tile and this request both work.
    if (carried > this.lastCarried) {
      this.withdrawTries = 0;
    }
    this.lastCarried = carried;

    if (++this.withdrawTries > CompanionFarmerBehaviour.WITHDRAW_TRIES) {
      this.withdrawTries = 0;
      this.logWithdrawDiagnostic(state, pos, base, bot, carried);

      if (!this.oneAtATime) {
        // A request for more than fits is a plausible refusal, so drop to a
        // single item before blaming where we are standing.
        console.log(`[${this.tag}] Retrying one item at a time.`);
        this.oneAtATime = true;
      } else {
        // Still nothing: we are probably not as "at base" as we think.
        const plan = this.withdrawPlan!;
        plan.index = (plan.index + 1) % plan.spots.length;
        console.log(`[${this.tag}] Moving onto ${this.describe(plan)} and trying again.`);
        return this.mover.step(state, pos, this.target(state, plan));
      }
    }

    const item = base.Inventory[0];
    const quantity = this.oneAtATime ? 1 : item.Quantity;
    console.log(`[${this.tag}] Withdrawing ${item.ItemName} x${quantity} from base.`);
    return new MessageProtocol.WithdrawFromBaseAction(item.ItemName, quantity);
  }

  /** Why nothing is coming out of storage. Mirrors the gatherer's deposit dump. */
  private logWithdrawDiagnostic(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    base: MessageProtocol.BaseInfo,
    bot: MessageProtocol.PlayerInfo,
    carried: number,
  ): void {
    const tile = state.getTileAt(pos);
    const storage = base.Inventory.slice(0, 6)
      .map((s) => `${s.ItemName}x${s.Quantity}`)
      .join(", ");

    console.log(`=== [${this.tag}] withdraw diagnostic ===`);
    console.log(`  bot at        : ${pos.X},${pos.Y}  (aiming for ${this.describe(this.withdrawPlan!)})`);
    console.log(`  base.Position : ${base.Position.X},${base.Position.Y} ${base.Width}x${base.Height}`);
    console.log(`  distanceTo    : ${BaseGeometry.distanceTo(base, pos)} (inside=${BaseGeometry.contains(base, pos)})`);
    console.log(`  carrying      : ${carried} in ${bot.Inventory.length}/${bot.Slots} slots`);
    console.log(`  base storage  : ${base.Inventory.length}/${base.StorageSlots} stacks [${storage}]`);
    console.log(
      `  tile here     : ${tile ? `${tile.Terrain}/${tile.Zone} owner=${tile.ZoneOwnerTeamId}` : "NOT VISIBLE"}`,
    );
    console.log("  -> check the [SERVER] Error lines above for the refusal reason.");
    console.log("======================================");
  }

  private carriedCount(bot: MessageProtocol.PlayerInfo): number {
    return bot.Inventory.reduce((total, stack) => total + stack.Quantity, 0);
  }

  // ─── Phase: move ────────────────────────────────────────────────────────────

  private doMove(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    base: MessageProtocol.BaseInfo,
  ): MessageProtocol.ActionBase | null {
    const target = this.target(state, this.standbyPlan!);

    if (pos.X === target.X && pos.Y === target.Y) {
      console.log(`[${this.tag}] At standby ${pos.X},${pos.Y}, starting companion sends.`);
      this.phase = "send";
      return null;
    }

    // Anywhere just outside the hull will do. If we are already there and the
    // tile we picked will not let us in, stop walking and get on with it.
    if (
      this.standbyPlan!.stuckTicks >= CompanionFarmerBehaviour.STUCK_TICKS &&
      BaseGeometry.distanceTo(base, pos) === 1
    ) {
      console.log(
        `[${this.tag}] Cannot reach ${target.X},${target.Y}; standing by at ${pos.X},${pos.Y} instead.`,
      );
      this.standbyPlan!.spots = [new MessageProtocol.Position(pos.X, pos.Y)];
      this.standbyPlan!.index = 0;
      this.standbyPlan!.stuckTicks = 0;
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
    const carried = this.carriedCount(bot);

    if (carried === 0) {
      console.log(`[${this.tag}] Inventory empty, heading back to base.`);
      this.phase = "withdraw";
      this.withdrawTries = 0;
      this.lastCarried = 0;
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

  private plan(spots: MessageProtocol.Position[]): SpotPlan {
    return { spots, index: 0, stuckTicks: 0 };
  }

  /**
   * The tile this plan is currently walking to. Skips tiles we can see are
   * impassable, and gives up on one that keeps refusing us — the hull is in the
   * way of some of these candidates by definition.
   */
  private target(
    state: MessageProtocol.GameState,
    plan: SpotPlan,
  ): MessageProtocol.Position {
    if (this.mover.lastMoveRefused) {
      plan.stuckTicks++;
    } else {
      plan.stuckTicks = 0;
    }

    if (plan.stuckTicks > CompanionFarmerBehaviour.STUCK_TICKS) {
      plan.stuckTicks = 0;
      plan.index = (plan.index + 1) % plan.spots.length;
      console.log(
        `[${this.tag}] Cannot get to ${this.describe(plan)}; trying the next tile ` +
          `(${plan.index + 1}/${plan.spots.length}).`,
      );
    }

    // Visibly blocked tiles are skipped outright rather than walked into first.
    for (let skipped = 0; skipped < plan.spots.length; skipped++) {
      const spot = plan.spots[plan.index];
      if (PathfindingMover.isPassable(state.getTileAt(spot))) {
        return spot;
      }
      plan.index = (plan.index + 1) % plan.spots.length;
    }

    return plan.spots[plan.index];
  }

  private describe(plan: SpotPlan): string {
    const spot = plan.spots[plan.index];
    return `${spot.X},${spot.Y}`;
  }
}

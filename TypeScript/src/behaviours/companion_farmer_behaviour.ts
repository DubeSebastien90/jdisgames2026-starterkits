import * as MessageProtocol from "../client/message_protocol";
import { IBehaviour } from "./ibehaviour";
import { IMover } from "../movement/imover";
import { PathfindingMover } from "../movement/pathfinding_mover";
import { BaseGeometry } from "../world/base_geometry";

/** A list of candidate tiles walked in order, moving on when one is a dead end. */
interface SpotPlan {
  spots: MessageProtocol.Position[];
  index: number;
  stuckTicks: number;
}

/**
 * Farms the companion badges. "Rock And Stone!" counts companions sent home
 * (500 for the top tier) and "Mini-Mes" counts how many are travelling at once
 * (6), so this bot exists to send as many as it can, as often as it can.
 *
 * The items come out of storage and the companions put them straight back, so
 * nothing is consumed — the only real cost is a tick per send.
 *
 * It parks against the hull and never moves again. Only one action fits in a
 * tick (see GameClient), so every tick spent walking is a companion not sent,
 * and standing next to the base is also the shortest possible trip home for a
 * companion, which is what frees its slot for the next one.
 */
export class CompanionFarmerBehaviour implements IBehaviour {
  public readonly name = "companion-farmer";

  // Refused moves in a row before we decide a candidate tile is unreachable and
  // try the next one. The hull blocks a lot of tiles, and the server does not
  // tell us which reading of BaseInfo.Position is the right one.
  private static readonly STUCK_TICKS = 6;
  // Touching the hull is close enough for base actions: a deposit has been seen
  // to succeed from a tile just outside it, and the inside is not walkable.
  // Measured in steps, so a tile touching a corner diagonally does not count.
  private static readonly BASE_RANGE = 1;
  // Withdraw requests that changed nothing before we accept it is not working
  // from here. Without this a refused withdraw is silent and repeats for ever.
  private static readonly WITHDRAW_TRIES = 5;
  // Rounds of companions to keep in the pack. Enough to fill every slot without
  // emptying storage, which the crafting and market side of the base needs.
  private static readonly LOADS_IN_HAND = 2;
  // Ticks between "storage is empty" reports, so waiting is not spammy.
  private static readonly EMPTY_LOG_EVERY = 25;

  /** Shared navigation: routes around trees, hulls and other bots. */
  private readonly mover: IMover = new PathfindingMover();

  private tag = "bot";
  private stationPlan: SpotPlan | null = null;
  private stationed = false;
  private withdrawTries = 0;
  /** Carried count when we asked, so the next tick can see if it worked. */
  private withdrawIssuedAt: number | null = null;
  private oneAtATime = false;
  /**
   * Items a companion takes, measured rather than assumed, so Companion I/II/III
   * are picked up on their own. Only used to size the pack.
   */
  private companionCapacity = 1;
  private sentAtCarried: number | null = null;
  private sends = 0;
  private refusedSends = 0;
  private lastEmptyLogTick = -CompanionFarmerBehaviour.EMPTY_LOG_EVERY;

  public getNextAction(state: MessageProtocol.GameState): MessageProtocol.ActionBase | null {
    if (!state.Bot || !state.Base || !state.Team) {
      return null;
    }

    this.tag = state.Bot.BotType || "bot";
    this.mover.observe(state, state.Bot.Position);

    const pos = state.Bot.Position;
    const base = state.Base;
    const team = state.Team;
    const bot = state.Bot;
    const carried = this.carriedCount(bot);

    this.measureCapacity(carried);
    this.observeWithdraw(carried);

    if (!this.stationPlan) {
      // Tiles just outside the hull: standable, and as close to the base as we
      // can get, since the interior is not walkable.
      this.stationPlan = { spots: BaseGeometry.perimeterTiles(base, "right"), index: 0, stuckTicks: 0 };
      console.log(
        `[${this.tag}] Base ${base.Position.X},${base.Position.Y} ${base.Width}x${base.Height}: ` +
          `stationing at ${this.describe(this.stationPlan)}.`,
      );
    }

    // Walk in once, then stay put for the rest of the match.
    if (BaseGeometry.stepsTo(base, pos) > CompanionFarmerBehaviour.BASE_RANGE) {
      this.stationed = false;
      return this.mover.step(state, pos, this.target(state, this.stationPlan));
    }

    if (!this.stationed) {
      this.stationed = true;
      console.log(`[${this.tag}] Stationed at ${pos.X},${pos.Y}, farming companions.`);
    }

    // Sending outranks everything: it is the badge, and it frees pack space.
    if (carried > 0 && team.CompanionNumber < team.CompanionSlots) {
      return this.send(team, carried);
    }

    // Every slot busy, or nothing to hand one. Either way, topping the pack up
    // is the useful thing to do with the tick.
    const wanted = this.packTarget(team);
    if (carried < wanted && base.Inventory.length > 0) {
      return this.withdraw(state, pos, base, bot, carried);
    }

    if (carried === 0 && base.Inventory.length === 0) {
      this.logEmptyStorage(state, base);
    }

    // Pack is stocked and every companion is out. Nothing to do but wait for a
    // slot, which is the throughput ceiling of this whole strategy.
    return null;
  }

  // ─── Sending ────────────────────────────────────────────────────────────────

  private send(
    team: MessageProtocol.TeamInfo,
    carried: number,
  ): MessageProtocol.ActionBase {
    this.sentAtCarried = carried;
    this.sends++;

    console.log(
      `[${this.tag}] Companion ${this.sends} away (${carried} in hand, ` +
        `${team.CompanionNumber + 1}/${team.CompanionSlots} slots in use).`,
    );

    return new MessageProtocol.SendCompanionAction();
  }

  /**
   * A companion takes as much as it can hold, so the drop in what we carry is
   * its capacity. Also how we notice sends being refused outright.
   */
  private measureCapacity(carried: number): void {
    if (this.sentAtCarried === null) {
      return;
    }

    const shipped = this.sentAtCarried - carried;
    this.sentAtCarried = null;

    if (shipped > this.companionCapacity) {
      console.log(`[${this.tag}] A companion carried ${shipped}, so capacity is now ${shipped}.`);
      this.companionCapacity = shipped;
      this.refusedSends = 0;
      return;
    }

    if (shipped <= 0 && ++this.refusedSends === 3) {
      console.log(
        `[${this.tag}] 3 companions took nothing. The send is being refused — ` +
          "check the [SERVER] Error lines above.",
      );
    }
  }

  /** Enough items to fill every slot a couple of times over, and no more. */
  private packTarget(team: MessageProtocol.TeamInfo): number {
    const slots = Math.max(team.CompanionSlots, 1);
    return slots * this.companionCapacity * CompanionFarmerBehaviour.LOADS_IN_HAND;
  }

  // ─── Withdrawing ────────────────────────────────────────────────────────────

  private withdraw(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    base: MessageProtocol.BaseInfo,
    bot: MessageProtocol.PlayerInfo,
    carried: number,
  ): MessageProtocol.ActionBase | null {
    if (bot.Slots > 0 && bot.Inventory.length >= bot.Slots) {
      // No free slot for another stack. Whatever we hold is enough to send.
      return null;
    }

    if (this.withdrawTries > CompanionFarmerBehaviour.WITHDRAW_TRIES) {
      this.withdrawTries = 0;
      this.logWithdrawDiagnostic(state, pos, base, bot, carried);

      if (!this.oneAtATime) {
        // A request for more than fits is a plausible refusal, so drop to a
        // single item before blaming where we are standing.
        console.log(`[${this.tag}] Retrying one item at a time.`);
        this.oneAtATime = true;
      } else {
        // Still nothing: we are probably not as "at base" as we think.
        const plan = this.stationPlan!;
        plan.index = (plan.index + 1) % plan.spots.length;
        console.log(`[${this.tag}] Restationing at ${this.describe(plan)} and trying again.`);
        this.stationed = false;
        return this.mover.step(state, pos, this.target(state, plan));
      }
    }

    // The biggest stack, not the first one. A withdraw costs a tick whatever
    // its size, and storage fills up with dribs and drabs as companions arrive,
    // so taking the first stack can mean fetching a single item per tick.
    const item = this.biggestStack(base);
    const quantity = this.oneAtATime ? 1 : item.Quantity;
    this.withdrawIssuedAt = carried;
    console.log(`[${this.tag}] Withdrawing ${item.ItemName} x${quantity} from base.`);
    return new MessageProtocol.WithdrawFromBaseAction(item.ItemName, quantity);
  }

  /**
   * Did the last withdraw arrive? Measured on the tick after the request and
   * against what we held when we asked — not against the previous withdraw. A
   * companion leaves with the items in between, so comparing across withdraws
   * makes a working tile look broken and sends us wandering off it.
   */
  private observeWithdraw(carried: number): void {
    if (this.withdrawIssuedAt === null) {
      return;
    }

    const gained = carried - this.withdrawIssuedAt;
    this.withdrawIssuedAt = null;

    if (gained > 0) {
      this.withdrawTries = 0;
      if (this.oneAtATime) {
        // The refusal was about where we stood, not the size of the request,
        // and one item per tick is a fraction of the send rate.
        console.log(`[${this.tag}] Withdraw works here; back to whole stacks.`);
        this.oneAtATime = false;
      }
      return;
    }

    this.withdrawTries++;
  }

  private biggestStack(base: MessageProtocol.BaseInfo): MessageProtocol.ItemStack {
    return base.Inventory.reduce((best, stack) =>
      stack.Quantity > best.Quantity ? stack : best,
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * The tile we are walking to. Skips tiles we can see are impassable, and
   * gives up on one that keeps refusing us — the hull is in the way of some of
   * these candidates by definition.
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

    for (let skipped = 0; skipped < plan.spots.length; skipped++) {
      const spot = plan.spots[plan.index];
      if (PathfindingMover.isPassable(state.getTileAt(spot))) {
        return spot;
      }
      plan.index = (plan.index + 1) % plan.spots.length;
    }

    return plan.spots[plan.index];
  }

  private carriedCount(bot: MessageProtocol.PlayerInfo): number {
    return bot.Inventory.reduce((total, stack) => total + stack.Quantity, 0);
  }

  private describe(plan: SpotPlan): string {
    const spot = plan.spots[plan.index];
    return `${spot.X},${spot.Y}`;
  }

  private logEmptyStorage(
    state: MessageProtocol.GameState,
    base: MessageProtocol.BaseInfo,
  ): void {
    if (state.CurrentTick - this.lastEmptyLogTick < CompanionFarmerBehaviour.EMPTY_LOG_EVERY) {
      return;
    }
    this.lastEmptyLogTick = state.CurrentTick;
    console.log(
      `[${this.tag}] Storage is empty (${base.Inventory.length}/${base.StorageSlots} stacks), ` +
        `${this.sends} companions sent so far. Waiting on the gatherer.`,
    );
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
    console.log(`  bot at        : ${pos.X},${pos.Y}  (station ${this.describe(this.stationPlan!)})`);
    console.log(`  base.Position : ${base.Position.X},${base.Position.Y} ${base.Width}x${base.Height}`);
    console.log(
      `  stepsTo hull  : ${BaseGeometry.stepsTo(base, pos)} ` +
        `(chebyshev=${BaseGeometry.distanceTo(base, pos)}, inside=${BaseGeometry.contains(base, pos)})`,
    );
    console.log(`  carrying      : ${carried} in ${bot.Inventory.length}/${bot.Slots} slots`);
    console.log(`  base storage  : ${base.Inventory.length}/${base.StorageSlots} stacks [${storage}]`);
    console.log(
      `  tile here     : ${tile ? `${tile.Terrain}/${tile.Zone} owner=${tile.ZoneOwnerTeamId}` : "NOT VISIBLE"}`,
    );
    console.log("  -> check the [SERVER] Error lines above for the refusal reason.");
    console.log("======================================");
  }
}

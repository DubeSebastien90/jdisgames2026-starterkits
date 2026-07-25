import * as MessageProtocol from "../client/message_protocol";
import { IBehaviour } from "./ibehaviour";
import { IMover } from "../movement/imover";
import { PathfindingMover } from "../movement/pathfinding_mover";
import { BaseGeometry } from "../world/base_geometry";

/** Candidate tiles to farm from, walked in order until one of them works. */
interface SpotPlan {
  spots: MessageProtocol.Position[];
  index: number;
  stuckTicks: number;
  cycled: boolean;
}

/**
 * Farms the companion badges. "Rock And Stone!" counts companions sent home
 * (500 for the top tier) and "Mini-Mes" counts how many are travelling at once
 * (6), so this bot exists to send as many as it can, as often as it can.
 *
 * The items come out of storage and the companions put them straight back, so
 * nothing is consumed — the only real cost is a tick per send.
 *
 * It settles on one tile and never moves again. Only one action fits in a tick
 * (see GameClient), so every tick spent walking is a companion not sent, and
 * standing at the base is also the shortest trip home for a companion, which is
 * what frees its slot for the next one.
 */
export class CompanionFarmerBehaviour implements IBehaviour {
  public readonly name = "companion-farmer";

  // Refused moves in a row before we decide a candidate tile is unreachable.
  private static readonly STUCK_TICKS = 6;
  // Withdraw requests that changed nothing before we try something else.
  private static readonly WITHDRAW_TRIES = 3;
  // The server refuses a withdraw asking for more than this, whole stack or not
  // — a request for Sugar Cane x100 fails where x10 succeeds. Learned downward
  // from what actually arrives, so a smaller real cap sorts itself out.
  private static readonly MAX_WITHDRAW = 10;
  // Rounds of companions to keep in the pack. Enough to fill every slot without
  // emptying storage, which the crafting and market side of the base needs.
  private static readonly LOADS_IN_HAND = 2;
  // Ticks between "storage is empty" reports, so waiting is not spammy.
  private static readonly EMPTY_LOG_EVERY = 25;
  // Fetch a load, walk away from the base, then dump the whole load as sends.
  //
  // Standing inside the base and sending from there is about twice as fast per
  // send, but a companion then arrives within a tick, so only one is ever in
  // flight and "Mini-Mes" (2/4/6 at once) can never be earned. Walking out puts
  // the whole load in the air at the same time. Set false for pure send rate.
  private static readonly SHUTTLE = true;
  // How far to get from the base before sending. A companion needs about this
  // many ticks to walk home, which is what keeps that many of them travelling.
  private static readonly SHUTTLE_DISTANCE = 6;

  /** Shared navigation: routes around trees, hulls and other bots. */
  private readonly mover: IMover = new PathfindingMover();

  private tag = "bot";
  private plan: SpotPlan | null = null;
  /** Set once a withdraw has worked here, after which we never move again. */
  private stationLocked = false;
  private announcedStation = false;
  private withdrawCap = CompanionFarmerBehaviour.MAX_WITHDRAW;
  /**
   * Which spelling of the item name we are trying. Storage reports a display
   * name ("Sugar Cane") while the rest of the protocol speaks in ids
   * ("sugar_cane"), and only one of them may be what WithdrawFromBase wants.
   */
  private variantIndex = 0;
  private withdrawTries = 0;
  /** What we held and asked for, so the next tick can see if it worked. */
  private withdrawIssuedAt: number | null = null;
  private withdrawRequested = 0;
  /**
   * Items a companion takes, measured rather than assumed, so Companion I/II/III
   * are picked up on their own. Only used to size the pack.
   */
  private companionCapacity = 1;
  private sentAtCarried: number | null = null;
  private sends = 0;
  private refusedSends = 0;
  private lastEmptyLogTick = -CompanionFarmerBehaviour.EMPTY_LOG_EVERY;
  /** Where to stand to launch, far enough out that companions pile up. */
  private padSpot: MessageProtocol.Position | null = null;
  private announcedPad = false;
  /**
   * Set once every companion slot has been in the air at the same time.
   * "Mini-Mes" is a one-off — 2, 4 and 6 at once, and 6 covers all three — so
   * once it has happened there is nothing left to buy by walking out, and we
   * switch to the faster send-from-inside loop for the rest of the match.
   */
  private allSlotsSeenFull = false;

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
    this.observeWithdraw(carried, pos);


    if (!this.plan) {
      // Inside the hull first, under both readings of BaseInfo.Position, then
      // the tiles around it as a fallback in case standing inside is not what
      // the server actually wants.
      this.plan = {
        spots: [...BaseGeometry.interiorTiles(base), ...BaseGeometry.perimeterTiles(base, "right")],
        index: 0,
        stuckTicks: 0,
        cycled: false,
      };
      console.log(
        `[${this.tag}] Base ${base.Position.X},${base.Position.Y} ${base.Width}x${base.Height}: ` +
          `${this.plan.spots.length} candidate tiles, starting with ${this.describe()}.`,
      );
    }

    // Carrying a load: walk it clear of the base, then launch the lot.
    if (carried > 0 && CompanionFarmerBehaviour.SHUTTLE && !this.allSlotsSeenFull) {
      return this.launch(state, pos, base, team, carried);
    }

    // Sending works anywhere and is the whole point, so it always goes first.
    if (carried > 0 && team.CompanionNumber < team.CompanionSlots) {
      return this.send(team, carried);
    }

    // Walk to the tile we are currently betting on.
    const station = this.target(state);
    if (pos.X !== station.X || pos.Y !== station.Y) {
      this.announcedStation = false;
      return this.mover.step(state, pos, station);
    }

    if (!this.announcedStation) {
      this.announcedStation = true;
      console.log(
        `[${this.tag}] At ${pos.X},${pos.Y} (inside=${BaseGeometry.contains(base, pos)}), ` +
          `${this.stationLocked ? "locked in" : "trying a withdraw"}.`,
      );
    }

    // Every slot busy, or nothing to hand one. Topping the pack up is the
    // useful thing to do with the tick either way.
    if (carried < this.packTarget(team) && base.Inventory.length > 0) {
      return this.withdraw(state, pos, base, bot, carried);
    }

    if (carried === 0 && base.Inventory.length === 0) {
      this.logEmptyStorage(state, base);
    }

    return null;
  }

  // ─── Launching ──────────────────────────────────────────────────────────────

  /**
   * Get clear of the base, then send the whole load from there so every
   * companion is walking home at the same time.
   *
   * The distance is checked rather than the tile, so it starts sending as soon
   * as it is far enough even if the exact pad tile turns out to be unreachable.
   */
  private launch(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    base: MessageProtocol.BaseInfo,
    team: MessageProtocol.TeamInfo,
    carried: number,
  ): MessageProtocol.ActionBase | null {
    if (this.manhattan(pos, base.Position) < CompanionFarmerBehaviour.SHUTTLE_DISTANCE) {
      this.announcedPad = false;
      return this.mover.step(state, pos, this.pad(base));
    }

    if (!this.announcedPad) {
      this.announcedPad = true;
      console.log(`[${this.tag}] At the pad ${pos.X},${pos.Y} with ${carried}, launching.`);
    }

    if (team.CompanionNumber < team.CompanionSlots) {
      return this.send(team, carried);
    }

    // Every slot in the air at once, which is the whole point of walking out.
    return null;
  }

  private pad(base: MessageProtocol.BaseInfo): MessageProtocol.Position {
    if (!this.padSpot) {
      const half = Math.floor(Math.max(base.Width, 1) / 2);
      this.padSpot = new MessageProtocol.Position(
        base.Position.X + half + CompanionFarmerBehaviour.SHUTTLE_DISTANCE,
        base.Position.Y,
      );
      console.log(`[${this.tag}] Launch pad set to ${this.padSpot.X},${this.padSpot.Y}.`);
    }

    return this.padSpot;
  }

  private manhattan(a: MessageProtocol.Position, b: MessageProtocol.Position): number {
    return Math.abs(a.X - b.X) + Math.abs(a.Y - b.Y);
  }

  // ─── Sending ────────────────────────────────────────────────────────────────

  private send(
    team: MessageProtocol.TeamInfo,
    carried: number,
  ): MessageProtocol.ActionBase {
    this.sentAtCarried = carried;
    this.sends++;

    const inFlight = team.CompanionNumber + 1;
    console.log(
      `[${this.tag}] Companion ${this.sends} away (${carried} in hand, ` +
        `${inFlight}/${team.CompanionSlots} slots in use).`,
    );

    // Counted here, not from the state: the state we are handed always predates
    // our own action, so the tick that fills the last slot never reports it.
    if (!this.allSlotsSeenFull && inFlight >= team.CompanionSlots) {
      this.allSlotsSeenFull = true;
      console.log(
        `[${this.tag}] That is all ${team.CompanionSlots} in the air at once — Mini-Mes banked. ` +
          "No more walking out; sending from the base is twice the rate.",
      );
    }

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

    if (this.withdrawTries >= CompanionFarmerBehaviour.WITHDRAW_TRIES) {
      this.withdrawTries = 0;
      this.logWithdrawDiagnostic(state, pos, base, bot, carried);
      return this.escalate(state, pos, this.nameVariants(this.biggestStack(base).ItemName).length);
    }

    // The biggest stack, not the first one: a withdraw costs a tick whatever its
    // size, and storage fills with dribs and drabs as companions arrive.
    const item = this.biggestStack(base);
    const quantity = Math.min(item.Quantity, this.withdrawCap);
    const name = this.nameVariants(item.ItemName)[this.variantIndex];

    this.withdrawIssuedAt = carried;
    this.withdrawRequested = quantity;
    console.log(
      `[${this.tag}] Withdrawing "${name}" x${quantity} from base` +
        (name === item.ItemName ? "." : ` (storage calls it "${item.ItemName}").`),
    );

    return new MessageProtocol.WithdrawFromBaseAction(name, quantity);
  }

  /**
   * Spellings of an item name to try, in order: exactly what storage reported,
   * then the id form the rest of the protocol uses (resources come through as
   * "sugar_cane", tiles as "cotton_candy"), then plain lower case.
   */
  private nameVariants(itemName: string): string[] {
    const snake = itemName.trim().replace(/\s+/g, "_").toLowerCase();
    const lower = itemName.trim().toLowerCase();
    return [...new Set([itemName, snake, lower])];
  }

  /**
   * Nothing is coming out of storage. Work through the three things it could
   * be, cheapest first: the spelling of the item name, then where we are
   * standing, then how much we asked for.
   */
  private escalate(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    variants: number,
  ): MessageProtocol.ActionBase | null {
    const plan = this.plan!;

    // Cheapest to rule out, and it costs no movement: try the other spellings
    // from right here before deciding the tile is wrong.
    if (this.variantIndex + 1 < variants) {
      this.variantIndex++;
      console.log(`[${this.tag}] Trying the item name a different way.`);
      return null;
    }
    this.variantIndex = 0;

    if (!plan.cycled) {
      plan.index = (plan.index + 1) % plan.spots.length;
      if (plan.index === 0) {
        plan.cycled = true;
      }
      console.log(
        `[${this.tag}] No luck here; trying ${this.describe()} ` +
          `(${plan.index + 1}/${plan.spots.length}).`,
      );
      this.announcedStation = false;
      return this.mover.step(state, pos, this.target(state));
    }

    if (this.withdrawCap > 1) {
      this.withdrawCap = Math.max(Math.floor(this.withdrawCap / 2), 1);
      plan.cycled = false;
      console.log(
        `[${this.tag}] Every tile refused x${this.withdrawCap * 2}. ` +
          `Starting again asking for x${this.withdrawCap}.`,
      );
      return null;
    }

    console.log(
      `[${this.tag}] Every tile refused even a single item. Read the [SERVER] Error ` +
        "lines: this is not about where we are standing or how much we asked for.",
    );
    return null;
  }

  /**
   * Did the last withdraw arrive? Measured on the tick after the request and
   * against what we held when we asked — not against the previous withdraw. A
   * companion leaves with the items in between, so comparing across withdraws
   * makes a working tile look broken and sends us wandering off it.
   */
  private observeWithdraw(carried: number, pos: MessageProtocol.Position): void {
    if (this.withdrawIssuedAt === null) {
      return;
    }

    const gained = carried - this.withdrawIssuedAt;
    const requested = this.withdrawRequested;
    this.withdrawIssuedAt = null;

    if (gained <= 0) {
      this.withdrawTries++;
      return;
    }

    this.withdrawTries = 0;

    if (!this.stationLocked) {
      this.stationLocked = true;
      console.log(
        `[${this.tag}] Withdraw works from ${pos.X},${pos.Y} with name variant ` +
          `${this.variantIndex + 1} — staying here for good.`,
      );
    }

    // Got some but not all of it: that is the real per-request cap.
    if (gained < requested) {
      console.log(`[${this.tag}] Asked for ${requested}, got ${gained}. Capping requests there.`);
      this.withdrawCap = gained;
    }
  }

  private biggestStack(base: MessageProtocol.BaseInfo): MessageProtocol.ItemStack {
    return base.Inventory.reduce((best, stack) =>
      stack.Quantity > best.Quantity ? stack : best,
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * The tile we are betting on. Once a withdraw has worked we never leave it.
   * Otherwise, skip tiles we can see are impassable and give up on one that
   * keeps refusing to let us in — the hull's own machines block some of them.
   */
  private target(state: MessageProtocol.GameState): MessageProtocol.Position {
    const plan = this.plan!;

    if (this.stationLocked) {
      return plan.spots[plan.index];
    }

    if (this.mover.lastMoveRefused) {
      plan.stuckTicks++;
    } else {
      plan.stuckTicks = 0;
    }

    if (plan.stuckTicks > CompanionFarmerBehaviour.STUCK_TICKS) {
      plan.stuckTicks = 0;
      plan.index = (plan.index + 1) % plan.spots.length;
      console.log(
        `[${this.tag}] Cannot get to ${this.describe()}; trying the next tile ` +
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

  private describe(): string {
    const plan = this.plan!;
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
    console.log(`  bot at        : ${pos.X},${pos.Y}  (candidate ${this.describe()})`);
    console.log(`  base.Position : ${base.Position.X},${base.Position.Y} ${base.Width}x${base.Height}`);
    console.log(
      `  inside hull   : ${BaseGeometry.contains(base, pos)} ` +
        `(steps=${BaseGeometry.stepsTo(base, pos)}, chebyshev=${BaseGeometry.distanceTo(base, pos)})`,
    );
    console.log(`  asked for     : x${this.withdrawRequested} (cap x${this.withdrawCap})`);
    console.log(`  carrying      : ${carried} in ${bot.Inventory.length}/${bot.Slots} slots`);
    console.log(`  base storage  : ${base.Inventory.length}/${base.StorageSlots} stacks [${storage}]`);
    console.log(
      `  tile here     : ${tile ? `${tile.Terrain}/${tile.Zone} owner=${tile.ZoneOwnerTeamId}` : "NOT VISIBLE"}`,
    );
    console.log("  -> check the [SERVER] Error lines above for the refusal reason.");
    console.log("======================================");
  }
}

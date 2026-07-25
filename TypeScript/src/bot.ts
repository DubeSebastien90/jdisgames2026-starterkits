import * as MessageProtocol from "./client/message_protocol";
import { IBot } from "./bot_logic/ibot";

type Phase = "seek" | "gather" | "return";

export class Bot implements IBot {
  // EDIT THIS FOR YOUR OWN BOT TOKEN
  public static readonly TOKEN = "BOTA-5a3y-D2Jk-C5yk";
  public static readonly TOKEN_B = "BOTB-5a3y-D2Jk-C5yk";

  // Head home once we carry this many items (or the inventory slots fill up).
  private static readonly CARRY_TARGET = 10;
  // Gathering from an adjacent tile that yields nothing for this many ticks
  // means the server wants us standing on the node instead.
  private static readonly STUCK_TICKS = 5;
  // Deposit attempts on one tile before assuming it is the wrong spot.
  private static readonly DEPOSIT_TRIES = 3;
  // DEBUG: every bot ignores the seek/gather/return logic below and just sends
  // DepositToBase every tick, wherever it stands. Set back to false for play.
  private static readonly FORCE_DEPOSIT = false;
  // Master switch for the sidestep-when-blocked behaviour below. Off for now:
  // the code stays put, it just never runs. Flip to true to re-enable.
  private static readonly USE_DETOUR = false;
  // Sidestep this many tiles when a move gets refused (usually a resource node
  // sitting in the way), then go back to normal navigation.
  private static readonly DETOUR_STEPS = 5;
  // Each repeated failure sidesteps another DETOUR_STEPS tiles, up to this many.
  private static readonly MAX_DETOUR_ATTEMPTS = 4;

  private phase: Phase = "seek";
  private targetId: number | null = null;
  private targetPosition: MessageProtocol.Position | null = null;
  private lastCarried = 0;
  private idleTicks = 0;
  private standOnNode = false;
  private depositSpots: MessageProtocol.Position[] | null = null;
  private probeIndex = 0;
  private depositTicks = 0;
  private posBeforeMove: MessageProtocol.Position | null = null;
  private lastMoveTarget: MessageProtocol.Position | null = null;
  private detourRemaining = 0;
  private detourDelta: { x: number; y: number } | null = null;
  private detourSide = 1;
  private detourAttempts = 0;
  private depositLocked = false;
  private lastDepositCarried: number | null = null;

  public getNextAction(
    state: MessageProtocol.GameState,
  ): MessageProtocol.ActionBase | null {
    if (!state.Bot) {
      return null;
    }

    const pos = state.Bot.Position;
    const carried = this.carriedCount(state.Bot.Inventory);

    if (Bot.FORCE_DEPOSIT) {
      return this.forceDeposit(state, pos, carried);
    }

    // Did last tick's move actually happen? Starts a detour if not.
    if (Bot.USE_DETOUR) {
      this.checkIfStuck(pos);
    }

    // A detour in progress outranks everything else until it finishes.
    if (Bot.USE_DETOUR && this.detourRemaining > 0 && this.detourDelta) {
      this.detourRemaining--;
      const side = this.detourDelta;
      console.log(`[BOT] Detour step, ${this.detourRemaining} left.`);
      return this.move(pos, new MessageProtocol.Position(pos.X + side.x, pos.Y + side.y));
    }

    // Checked in every phase, so a bot that starts (or restarts) already
    // loaded heads home instead of wandering off with a full pack.
    if (this.phase !== "return" && (carried >= Bot.CARRY_TARGET || this.slotsFull(state.Bot))) {
      console.log(`[BOT] Carrying ${carried}, heading back to base.`);
      return this.startReturn(state, pos, carried);
    }

    if (this.phase === "seek") {
      return this.seek(state, pos);
    }

    if (this.phase === "gather") {
      return this.gather(state, pos, carried);
    }

    return this.returnToBase(state, pos, carried);
  }

  /**
   * If the move we asked for last tick left us on the same tile, something is
   * in the way (usually a resource node). Sidestep perpendicular to whatever
   * direction we were trying to go.
   */
  private checkIfStuck(pos: MessageProtocol.Position): void {
    const from = this.posBeforeMove;
    const to = this.lastMoveTarget;
    this.posBeforeMove = null;
    this.lastMoveTarget = null;

    if (!from || !to) {
      return;
    }

    if (pos.X !== from.X || pos.Y !== from.Y) {
      // Moving normally again, so the obstacle is behind us.
      if (this.detourRemaining === 0) {
        this.detourAttempts = 0;
      }
      return;
    }

    // Wedged during the sidestep itself: back out the other way.
    if (this.detourRemaining > 0 && this.detourDelta) {
      this.detourDelta = { x: -this.detourDelta.x, y: -this.detourDelta.y };
      this.detourRemaining = Bot.DETOUR_STEPS;
      console.log("[BOT] Sidestep blocked too, reversing.");
      return;
    }

    // Blocked again right after a detour means the obstacle is longer than we
    // thought, so keep going the same way and reach further each time.
    this.detourAttempts = Math.min(this.detourAttempts + 1, Bot.MAX_DETOUR_ATTEMPTS);

    const wasHorizontal = to.X !== from.X;
    this.detourDelta = wasHorizontal
      ? { x: 0, y: this.detourSide }
      : { x: this.detourSide, y: 0 };
    this.detourRemaining = Bot.DETOUR_STEPS * this.detourAttempts;

    console.log(
      `[BOT] Move to ${to.X},${to.Y} refused. Sidestepping ${this.detourRemaining} ` +
        `tiles (${this.detourDelta.x},${this.detourDelta.y}).`,
    );
  }

  /** Every move goes through here so we can tell next tick whether it worked. */
  private move(
    from: MessageProtocol.Position,
    to: MessageProtocol.Position,
  ): MessageProtocol.MoveAction {
    this.posBeforeMove = from;
    this.lastMoveTarget = to;
    return new MessageProtocol.MoveAction(to);
  }

  /**
   * DEBUG path for FORCE_DEPOSIT: hammer DepositToBase every tick and report
   * whether the inventory actually drops, plus where we are standing.
   */
  private forceDeposit(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    carried: number,
  ): MessageProtocol.ActionBase {
    const tile = state.getTileAt(pos);
    const base = state.Base;
    const inventory =
      state.Bot?.Inventory.map((s) => `${s.ItemName}x${s.Quantity}`).join(", ") || "empty";

    if (this.depositTicks > 0 && carried < this.lastCarried) {
      console.log(`[FORCE] *** DEPOSIT WORKED *** ${this.lastCarried} -> ${carried} at ${pos.X},${pos.Y}`);
    }
    this.lastCarried = carried;
    this.depositTicks++;

    console.log(
      `[FORCE] tick=${state.CurrentTick} at ${pos.X},${pos.Y} carrying ${carried} (${inventory}) | ` +
        `base=${base ? `${base.Position.X},${base.Position.Y} ${base.Width}x${base.Height}` : "NULL"} | ` +
        `tile=${tile ? `${tile.Terrain}/${tile.Zone} owner=${tile.ZoneOwnerTeamId}` : "NOT VISIBLE"} | ` +
        `atBase=${base ? this.atBase(state, pos, base) : "n/a"}`,
    );

    return new MessageProtocol.DepositToBaseAction();
  }

  /** Walk left until a resource shows up in vision. */
  private seek(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    const node = this.nearestResource(pos, state.VisibleResources);
    if (!node) {
      return this.move(pos, new MessageProtocol.Position(pos.X - 1, pos.Y));
    }

    this.targetId = node.Id;
    this.targetPosition = node.Position;
    this.phase = "gather";
    this.idleTicks = 0;
    console.log(`[BOT] Targeting ${node.Name} at ${node.Position.X},${node.Position.Y}`);

    return this.gather(state, pos, this.carriedCount(state.Bot?.Inventory ?? []));
  }

  /** Close in on the node, then mine it until full or exhausted. */
  private gather(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    carried: number,
  ): MessageProtocol.ActionBase | null {
    const target = this.targetPosition;
    if (!target) {
      this.phase = "seek";
      return this.seek(state, pos);
    }

    if (carried >= Bot.CARRY_TARGET || this.slotsFull(state.Bot)) {
      console.log(`[BOT] Carrying ${carried}, heading back to base.`);
      return this.startReturn(state, pos, carried);
    }

    const range = this.standOnNode ? 0 : 1;
    const distance = this.chebyshev(pos, target);
    if (distance > range) {
      return this.stepToward(pos, target);
    }

    // In range. If mining yields nothing for a while, try standing on the node.
    if (carried > this.lastCarried) {
      this.idleTicks = 0;
    } else if (++this.idleTicks > Bot.STUCK_TICKS && !this.standOnNode) {
      console.log("[BOT] No yield from an adjacent tile, stepping onto the node.");
      this.standOnNode = true;
      this.idleTicks = 0;
    }
    this.lastCarried = carried;

    // Node gone or drained: take whatever we have home, or look for another.
    const node = state.VisibleResources.find((r) => r.Id === this.targetId);
    if (!node || node.CurrentAmount <= 0) {
      console.log("[BOT] Node depleted.");
      this.targetId = null;
      this.targetPosition = null;
      if (carried > 0) {
        return this.startReturn(state, pos, carried);
      }
      this.phase = "seek";
      return this.seek(state, pos);
    }

    return new MessageProtocol.GatherNodeAction(target);
  }

  /** Walk home and drop everything into storage, then start over. */
  private returnToBase(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    carried: number,
  ): MessageProtocol.ActionBase | null {
    if (carried === 0) {
      console.log("[BOT] Deposited, back to work.");
      this.phase = "seek";
      this.lastCarried = 0;
      this.depositSpots = null;
      this.probeIndex = 0;
      this.depositTicks = 0;
      this.depositLocked = false;
      this.lastDepositCarried = null;
      return this.seek(state, pos);
    }

    const base = state.Base;
    if (!base) {
      console.log("[BOT] No base in state, cannot deposit.");
      return null;
    }

    if (!this.depositSpots) {
      this.depositSpots = this.candidateDepositSpots(base);
    }

    const spot = this.depositSpots[this.probeIndex];
    if (pos.X !== spot.X || pos.Y !== spot.Y) {
      return this.stepToward(pos, spot);
    }

    if (this.depositTicks === 0) {
      this.logDepositDiagnostic(state, pos, base, carried, spot);
    }

    // The pack got lighter, so this tile works even if it only takes one stack
    // per action. Stay put and keep unloading instead of probing elsewhere.
    if (this.lastDepositCarried !== null && carried < this.lastDepositCarried) {
      if (!this.depositLocked) {
        console.log(`[BOT] Deposit accepted at ${spot.X},${spot.Y}, staying until empty.`);
        this.depositLocked = true;
      }
      this.depositTicks = 1;
    }
    this.lastDepositCarried = carried;

    if (this.depositLocked) {
      return new MessageProtocol.DepositToBaseAction();
    }

    // Deposit refused here: cycle to the next candidate base tile. Wraps round
    // rather than jamming on the last one, so a tile is never given up on.
    if (++this.depositTicks > Bot.DEPOSIT_TRIES) {
      this.depositTicks = 0;
      this.probeIndex = (this.probeIndex + 1) % this.depositSpots.length;
      const next = this.depositSpots[this.probeIndex];
      console.log(
        `[BOT] Deposit refused at ${spot.X},${spot.Y}. Trying ${next.X},${next.Y} ` +
          `(${this.probeIndex + 1}/${this.depositSpots.length}).`,
      );
      if (this.probeIndex === 0) {
        console.log("[BOT] Every base tile refused so far. Check [SERVER] Error lines above.");
      }
      return null;
    }

    return new MessageProtocol.DepositToBaseAction();
  }

  /**
   * We do not know whether BaseInfo.Position is the corner or the centre of
   * the base, nor which tile accepts a deposit, so build every plausible tile
   * and probe them in order.
   */
  private candidateDepositSpots(
    base: MessageProtocol.BaseInfo,
  ): MessageProtocol.Position[] {
    const width = Math.max(base.Width, 1);
    const height = Math.max(base.Height, 1);
    const seen = new Set<string>();
    const spots: MessageProtocol.Position[] = [];

    const push = (x: number, y: number): void => {
      const key = `${x},${y}`;
      if (!seen.has(key)) {
        seen.add(key);
        spots.push(new MessageProtocol.Position(x, y));
      }
    };

    push(base.Position.X, base.Position.Y);

    // Rectangle read as top-left anchored, then as centre anchored.
    for (const originX of [base.Position.X, base.Position.X - Math.floor(width / 2)]) {
      for (const originY of [base.Position.Y, base.Position.Y - Math.floor(height / 2)]) {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            push(originX + x, originY + y);
          }
        }
      }
    }

    return spots;
  }

  private logDepositDiagnostic(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    base: MessageProtocol.BaseInfo,
    carried: number,
    spot: MessageProtocol.Position,
  ): void {
    const tile = state.getTileAt(pos);
    const inventory = state.Bot?.Inventory.map((s) => `${s.ItemName}x${s.Quantity}`).join(", ");
    const nearby = state.VisibleStructures.filter(
      (s) => this.chebyshev(s.Position, pos) <= 3,
    ).map((s) => `${s.Type}@${s.Position.X},${s.Position.Y}(ally=${s.IsAlly})`);

    console.log("=== [BOT] deposit diagnostic ===");
    console.log(`  bot at        : ${pos.X},${pos.Y}  (probing spot ${spot.X},${spot.Y})`);
    console.log(`  carrying      : ${carried} -> ${inventory}`);
    console.log(`  base.Position : ${base.Position.X},${base.Position.Y} ${base.Width}x${base.Height}`);
    console.log(`  base storage  : ${base.StorageSlots} slots, ${base.Inventory.length} stacks`);
    console.log(`  team id       : ${state.Team?.Id}`);
    console.log(
      `  tile here     : ${tile ? `${tile.Terrain}/${tile.Zone} owner=${tile.ZoneOwnerTeamId} structure=${tile.HasStructure}` : "NOT VISIBLE"}`,
    );
    console.log(`  structures<=3 : ${nearby.length ? nearby.join(", ") : "none"}`);
    console.log(`  atBase()      : ${this.atBase(state, pos, base)}`);
    console.log("================================");
  }

  private startReturn(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    carried: number,
  ): MessageProtocol.ActionBase | null {
    this.phase = "return";
    this.targetId = null;
    this.targetPosition = null;
    this.standOnNode = false;
    this.idleTicks = 0;
    this.depositLocked = false;
    this.lastDepositCarried = null;
    return this.returnToBase(state, pos, carried);
  }

  /**
   * BaseInfo.Position could be the corner or the centre of the base rectangle,
   * so accept any of: our tile is a base zone we own, we are inside the
   * rectangle read as top-left, or we are exactly on Position.
   */
  private atBase(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    base: MessageProtocol.BaseInfo,
  ): boolean {
    const tile = state.getTileAt(pos);
    if (tile && tile.Zone.toLowerCase().includes("base")) {
      return tile.ZoneOwnerTeamId === null || tile.ZoneOwnerTeamId === state.Team?.Id;
    }

    const insideRect =
      pos.X >= base.Position.X &&
      pos.X < base.Position.X + Math.max(base.Width, 1) &&
      pos.Y >= base.Position.Y &&
      pos.Y < base.Position.Y + Math.max(base.Height, 1);

    return insideRect || (pos.X === base.Position.X && pos.Y === base.Position.Y);
  }

  /** One tile per tick, closing X first then Y. */
  private stepToward(
    from: MessageProtocol.Position,
    to: MessageProtocol.Position,
  ): MessageProtocol.MoveAction {
    const deltaX = to.X - from.X;
    const deltaY = to.Y - from.Y;

    return this.move(
      from,
      deltaX !== 0
        ? new MessageProtocol.Position(from.X + Math.sign(deltaX), from.Y)
        : new MessageProtocol.Position(from.X, from.Y + Math.sign(deltaY)),
    );
  }

  private nearestResource(
    from: MessageProtocol.Position,
    resources: MessageProtocol.Resource[],
  ): MessageProtocol.Resource | null {
    let best: MessageProtocol.Resource | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const resource of resources) {
      if (resource.CurrentAmount <= 0) {
        continue;
      }

      const distance =
        Math.abs(resource.Position.X - from.X) + Math.abs(resource.Position.Y - from.Y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = resource;
      }
    }

    return best;
  }

  private carriedCount(inventory: MessageProtocol.ItemStack[]): number {
    return inventory.reduce((total, stack) => total + stack.Quantity, 0);
  }

  private slotsFull(bot: MessageProtocol.PlayerInfo | null): boolean {
    return !!bot && bot.Slots > 0 && bot.Inventory.length >= bot.Slots;
  }

  private chebyshev(a: MessageProtocol.Position, b: MessageProtocol.Position): number {
    return Math.max(Math.abs(a.X - b.X), Math.abs(a.Y - b.Y));
  }
}

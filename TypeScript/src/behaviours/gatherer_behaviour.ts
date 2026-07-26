import * as MessageProtocol from "../client/message_protocol";
import { IBehaviour } from "./ibehaviour";
import { IMover } from "../movement/imover";
import { PathfindingMover } from "../movement/pathfinding_mover";
import { TeamClaims } from "../team/team_claims";
import {
  ALL_DIRECTIONS,
  DIRECTION_VECTORS,
  Direction,
  TeamScouting,
} from "../team/team_scouting";
import { BaseGeometry } from "../world/base_geometry";
import { ResourceKind, matchesResourceKind } from "../world/resource_kinds";
import { WorldMemory } from "../world/world_memory";

type Phase = "seek" | "gather" | "return";

/**
 * Mine the nearest node and ship the load home on companions, so the bot stays
 * on the node instead of walking back and forth. Falls back to hauling it home
 * itself when that is cheaper, or when every companion slot is busy.
 */
export class GathererBehaviour implements IBehaviour {
  public readonly name: string;

  /**
   * Which resource kinds this bot will mine, or null for "whatever is nearest".
   *
   * Passing kinds turns the gatherer into a specialist: one bot on sugar cane
   * and one on chocolate beats two bots racing each other to the same node, and
   * a recipe that wants one particular item gets it instead of whatever the map
   * happened to put in front of the bot.
   */
  private readonly kinds: readonly ResourceKind[] | null;

  /**
   * @param kinds one or more resource names to stick to. Node names ("sorbet")
   * and loot names ("ice_cream") both work — see ResourceKind. Omit for the
   * original behaviour: mine the nearest thing.
   */
  public constructor(kinds?: ResourceKind | readonly ResourceKind[]) {
    this.kinds =
      kinds === undefined ? null : Array.isArray(kinds) ? [...kinds] : [kinds as ResourceKind];
    this.name = this.kinds ? `gatherer:${this.kinds.join("+")}` : "gatherer";
  }

  /** Is this node one we are willing to mine? Everything, unless kinds was set. */
  private wanted(resource: MessageProtocol.Resource): boolean {
    return this.kinds === null || matchesResourceKind(resource, this.kinds);
  }

  // Head home once we carry this many items (or the inventory slots fill up).
  private static readonly CARRY_TARGET = 10;
  // Ticks of no yield AND no drop in the node's amount before we write a node
  // off. Generous on purpose: mining may take several ticks per item.
  private static readonly STUCK_TICKS = 25;
  // Deposit attempts on one tile before assuming it is the wrong spot.
  private static readonly DEPOSIT_TRIES = 3;
  // How far from the ship still counts as "at the ship" when we get wedged.
  private static readonly NEAR_BASE_RANGE = 2;
  // How far ahead to aim when exploring for resources.
  private static readonly SEEK_AHEAD = 12;
  // Ticks committed to one heading before reconsidering, so the bot actually
  // covers ground instead of dithering on the spot.
  private static readonly EXPLORE_LEG = 15;
  // Ticks between "everything is mined out" reports, so waiting is not spammy.
  private static readonly EMPTY_LOG_EVERY = 20;
  // How long a node that refused to yield is skipped over.
  private static readonly NODE_IGNORE_TTL = 60;
  // Assumed respawn time when the server did not give us a RemainingTicks to
  // go on. Sugarcane is 180s in the docs, so this is deliberately cautious.
  private static readonly RESPAWN_GUESS = 200;
  // DEBUG: ignore the seek/gather/return logic below and just send
  // DepositToBase every tick, wherever we stand. Set back to false for play.
  private static readonly FORCE_DEPOSIT = false;
  // Set false to go back to walking every load home yourself.
  private static readonly SHIP_BY_COMPANION = true;
  // Ticks of *no new items* before shipping a part-load rather than sitting on
  // it. This is a stall timer, not a deadline: every item mined resets it, so a
  // bot on a yielding node keeps filling until the companion leaves full, and
  // only a dry node makes it ship short.
  private static readonly FILL_WAIT_TICKS = 30;
  // Ticks between "here is why nothing shipped" reports.
  private static readonly SKIP_LOG_EVERY = 20;
  // Ticks to keep watching for the drop in what we carry after a send before
  // deciding the companion took nothing. Inventory updates arrive on their own
  // message, so the drop can land a tick or two after the send.
  private static readonly MEASURE_WINDOW = 3;
  // Skip nodes whose regen timer is still running: whatever is in them now is
  // the tail end of a refill, so it is not worth the walk while other nodes
  // sit at full stock. Set false to mine anything with a single item in it.
  private static readonly SKIP_REGENERATING = true;
  // Skip nodes with a pump or an extractor on them. A machine drains the node
  // on its own and hands the loot straight to the base, so mining it by hand
  // is just competing with our own structure for the same stock.
  private static readonly SKIP_MACHINE_NODES = true;

  /** How this bot gets around. Swap for SidestepMover to change navigation. */
  private readonly mover: IMover = new PathfindingMover();

  private tag = "bot";
  private phase: Phase = "seek";
  private targetId: number | null = null;
  private targetPosition: MessageProtocol.Position | null = null;
  private lastCarried = 0;
  private idleTicks = 0;
  private lastNodeAmount: number | null = null;
  private depositSpots: MessageProtocol.Position[] | null = null;
  private probeIndex = 0;
  private depositTicks = 0;
  private depositLocked = false;
  private lastDepositCarried: number | null = null;
  private lastEmptyLogTick = -GathererBehaviour.EMPTY_LOG_EVERY;
  private readonly ignoredNodes = new Map<number, number>();
  /**
   * Nodes we have seen a pump or an extractor sitting on, so they stay skipped
   * after they drop out of vision. Re-checked whenever the node is visible, so
   * a destroyed machine puts the node back in play.
   */
  private readonly machineNodes = new Set<number>();
  /** Whether the map on disk has been folded into knownNodes yet. */
  private seeded = false;
  private exploreDirection: Direction | null = null;
  private exploreTicksLeft = 0;
  private exploreCount = 0;
  private lastRevisitKey: string | null = null;
  /**
   * How many items a companion took last time, which is what one can carry.
   * Starts at the un-researched capacity of 1 and is re-measured on every send,
   * so Companion I/II/III are picked up the moment they finish — nothing here
   * needs to know they exist.
   */
  private companionCapacity = 1;
  /** Carried count on the tick we sent, so a later tick can measure the drop. */
  private sentAtCarried: number | null = null;
  /** When that send went out, so the measurement can wait for slow inventory. */
  private sentAtTick: number | null = null;
  private sends = 0;
  private refusedSends = 0;
  /**
   * Ticks spent holding out for the probe load. Capacity is only ever learned by
   * sending, so a bot that never reaches capacity + 1 — a dry node, a slow
   * yield, one item left — would hold that load for the rest of the game
   * waiting to probe with it. The wait is bounded so it ships anyway.
   */
  private fillStallTicks = 0;
  /** What we were carrying last tick, to tell "still filling" from "stalled". */
  private lastFillCarried = 0;
  /** Last tick we said why a send was skipped, so the reason is not spammy. */
  private lastSkipLogTick = -GathererBehaviour.SKIP_LOG_EVERY;
  /** Every node we have ever seen, so respawns out of vision are not lost. */
  private readonly knownNodes = new Map<
    number,
    {
      name: string;
      position: MessageProtocol.Position;
      amount: number;
      respawnTicks: number;
      seenTick: number;
      /** Whether it was a kind we mine, judged when we could still see it. */
      wanted: boolean;
    }
  >();

  public getNextAction(
    state: MessageProtocol.GameState,
  ): MessageProtocol.ActionBase | null {
    if (!state.Bot) {
      return null;
    }

    // Both bots log to the same console, so stamp every line with which one.
    this.tag = state.Bot.BotType || "bot";
    this.seedFromWorldMemory(state);
    this.rememberVisibleNodes(state);

    const pos = state.Bot.Position;
    const carried = this.carriedCount(state.Bot.Inventory);

    if (GathererBehaviour.FORCE_DEPOSIT) {
      return this.forceDeposit(state, pos, carried);
    }

    // Let the mover see whether last tick's move actually happened.
    this.mover.observe(state, pos);

    // How much a companion took tells us its capacity, so measure it first.
    this.measureCapacity(carried, state.CurrentTick);

    // Shipping is tried in every phase: on the node, on the way to one, and
    // even while walking home, since anything a companion takes is one less
    // item to carry.
    const shipment = this.trySendCompanion(state, pos, carried);
    if (shipment) {
      return shipment;
    }

    // Checked in every phase, so a bot that starts (or restarts) already
    // loaded heads home instead of wandering off with a full pack.
    if (
      this.phase !== "return" &&
      (carried >= GathererBehaviour.CARRY_TARGET || this.slotsFull(state.Bot))
    ) {
      console.log(`[${this.tag}] Carrying ${carried}, heading back to base.`);
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
   * Hand the load to a companion instead of walking it home, when there is a
   * free slot and that is the cheaper way to move it.
   *
   * One SendCompanion dispatches one companion, which walks home and unloads on
   * its own — so this is called once per companion, not once per load, and the
   * bot keeps mining in between.
   */
  private trySendCompanion(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    carried: number,
  ): MessageProtocol.ActionBase | null {
    if (!GathererBehaviour.SHIP_BY_COMPANION || carried <= 0 || !state.Team) {
      return null;
    }

    if (!this.shippingBeatsWalking(state, pos)) {
      // Only ever false with a known base, since an unknown one ships by default.
      const distance = state.Base ? this.manhattan(pos, state.Base.Position) : 0;
      this.logSkip(
        state,
        `base is only ${distance} away, so walking ${GathererBehaviour.CARRY_TARGET} home ` +
          `beats ${GathererBehaviour.CARRY_TARGET / this.companionCapacity} sends`,
      );
      return null;
    }

    // Send companions full. A companion takes as much as it can hold and no
    // more, so dispatching one while we carry 2 of the 5 it could take throws
    // away three items, a slot, and the round trip — and slots are the scarce
    // thing, not items.
    //
    // The load we hold out for is one *more* than we think fits, so every send
    // doubles as a probe for a capacity the research tree has raised (see
    // measureCapacity). Never past a load we would carry home ourselves, or the
    // walk-home check fires first and we set off on a trip we did not need.
    const fullLoad = Math.min(
      this.companionCapacity + 1,
      GathererBehaviour.CARRY_TARGET,
    );
    // A full pack or a walk home means no more items are coming, so whatever is
    // in hand is as full as this companion is ever going to be.
    const stillFilling = !this.slotsFull(state.Bot) && this.phase !== "return";

    // Every item mined resets the clock: while the load grows, keep filling.
    // A drop counts too — a deposit or a send means the next load starts fresh,
    // and it must not inherit a stall clock from the last one.
    if (carried !== this.lastFillCarried) {
      this.fillStallTicks = 0;
    }
    this.lastFillCarried = carried;

    if (carried < fullLoad && stillFilling) {
      if (++this.fillStallTicks <= GathererBehaviour.FILL_WAIT_TICKS) {
        this.logSkip(
          state,
          `holding ${carried} until a companion can leave with ${fullLoad}, ` +
            `${GathererBehaviour.FILL_WAIT_TICKS - this.fillStallTicks + 1} ticks before shipping anyway`,
        );
        return null;
      }

      // Nothing arriving. A part-load in the base beats a full one in our pack.
      this.logSkip(
        state,
        `no new items for ${GathererBehaviour.FILL_WAIT_TICKS} ticks, shipping ${carried} of ${fullLoad}`,
      );
    }

    // Every slot busy. Nothing to do but keep mining, and if the pack is full
    // the caller falls through to walking it home instead of idling here.
    if (state.Team.CompanionNumber >= state.Team.CompanionSlots) {
      this.logSkip(
        state,
        `every companion slot is busy (${state.Team.CompanionNumber}/${state.Team.CompanionSlots}). ` +
          `A slot count of 0 means companions are not researched yet`,
      );
      return null;
    }

    this.sentAtCarried = carried;
    this.sentAtTick = state.CurrentTick;
    this.fillStallTicks = 0;
    this.lastFillCarried = 0;
    this.sends++;
    console.log(
      `[${this.tag}] Companion ${this.sends} away with up to ${this.companionCapacity} of ${carried} ` +
        `(${state.Team.CompanionNumber + 1}/${state.Team.CompanionSlots} slots in use).`,
    );

    return new MessageProtocol.SendCompanionAction();
  }

  /**
   * Say why nothing shipped this tick. Every check above returns null quietly on
   * its own, which makes a bot that never sends a companion impossible to read
   * from the console. Throttled, because most of these are true for a long run
   * of ticks rather than one.
   */
  private logSkip(state: MessageProtocol.GameState, reason: string): void {
    if (
      state.CurrentTick - this.lastSkipLogTick <
      GathererBehaviour.SKIP_LOG_EVERY
    ) {
      return;
    }

    this.lastSkipLogTick = state.CurrentTick;
    console.log(`[${this.tag}] No companion sent: ${reason}.`);
  }

  /**
   * Walking a full load home costs 2 x distance moves plus the deposit, all of
   * them ticks we are not mining. Shipping the same load costs one tick per
   * companion, so it wins everywhere except right next to the base — and wins
   * by more with every capacity upgrade.
   */
  private shippingBeatsWalking(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): boolean {
    const base = state.Base;
    if (!base) {
      // Nowhere known to walk to, so companions are the only way to deliver.
      return true;
    }

    // CARRY_TARGET is the load we would otherwise walk home, so that is what
    // the two options are compared over.
    const sends = GathererBehaviour.CARRY_TARGET / this.companionCapacity;
    const walk = 2 * this.manhattan(pos, base.Position) + 1;

    return sends < walk;
  }

  /**
   * A companion takes as much as it can hold, so the drop in what we carry is
   * its capacity — provided we were holding at least that much.
   *
   * The drop does not have to show up on the very next tick. Inventory arrives
   * on its own ReceivePlayerInfo message, independent of the Tick that makes us
   * act (see GameClient), so a send can look like it took nothing simply because
   * the new inventory has not landed yet. Hence the window: we keep looking for
   * the drop for a few ticks before calling a send refused.
   */
  private measureCapacity(carried: number, tick: number): void {
    if (this.sentAtCarried === null) {
      return;
    }

    const shipped = this.sentAtCarried - carried;

    if (shipped > 0) {
      this.sentAtCarried = null;
      this.refusedSends = 0;

      if (shipped > this.companionCapacity) {
        console.log(
          `[${this.tag}] A companion carried ${shipped} items, so capacity is now ${shipped}.`,
        );
        this.companionCapacity = shipped;
      }
      return;
    }

    // Nothing has moved yet. Give the inventory a few ticks to catch up.
    if (
      this.sentAtTick !== null &&
      tick - this.sentAtTick < GathererBehaviour.MEASURE_WINDOW
    ) {
      return;
    }

    this.sentAtCarried = null;
    if (++this.refusedSends === 3) {
      console.log(
        `[${this.tag}] 3 companions took nothing. Check the [SERVER] Error lines: ` +
          `the send is being refused, not the capacity being small.`,
      );
    }
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
      console.log(
        `[${this.tag}/FORCE] *** DEPOSIT WORKED *** ${this.lastCarried} -> ${carried} at ${pos.X},${pos.Y}`,
      );
    }
    this.lastCarried = carried;
    this.depositTicks++;

    console.log(
      `[${this.tag}/FORCE] tick=${state.CurrentTick} at ${pos.X},${pos.Y} carrying ${carried} (${inventory}) | ` +
        `base=${base ? `${base.Position.X},${base.Position.Y} ${base.Width}x${base.Height}` : "NULL"} | ` +
        `tile=${tile ? `${tile.Terrain}/${tile.Zone} owner=${tile.ZoneOwnerTeamId}` : "NOT VISIBLE"} | ` +
        `atBase=${base ? BaseGeometry.isAtBase(state, pos, base) : "n/a"}`,
    );

    return new MessageProtocol.DepositToBaseAction();
  }

  /**
   * Head for the nearest node that still has something in it. Nodes run out
   * and respawn on a timer, so when everything in sight is empty we wait next
   * to the closest one rather than wandering out of the area.
   */
  private seek(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    const node = this.nearestResource(pos, state.VisibleResources, true, state.CurrentTick);
    if (!node) {
      // Nothing worth mining in sight. Respawns take minutes, so go find
      // another patch instead of standing around waiting for this one.
      const empty = this.nearestResource(pos, state.VisibleResources, false, state.CurrentTick);
      if (empty) {
        this.logEmptyNodes(state, pos, empty);
      }

      // Before wandering off, check the nodes we have seen before. One we
      // emptied ages ago has had time to respawn, and we know where it is.
      const remembered = this.bestRememberedNode(state, pos);
      if (remembered) {
        this.exploreDirection = null;
        this.exploreTicksLeft = 0;
        TeamScouting.release(this.tag);
        this.logRevisit(state, remembered);
        return this.mover.step(state, pos, remembered.position);
      }

      return this.explore(state, pos);
    }

    this.exploreDirection = null;
    this.exploreTicksLeft = 0;
    TeamScouting.release(this.tag);

    this.targetId = node.Id;
    this.targetPosition = node.Position;
    this.phase = "gather";
    this.idleTicks = 0;
    TeamClaims.claim(node.Id, this.tag, state.CurrentTick);
    console.log(`[${this.tag}] Targeting ${node.Name} at ${node.Position.X},${node.Position.Y}`);

    return this.gather(state, pos, this.carriedCount(state.Bot?.Inventory ?? []));
  }

  /**
   * Fill knownNodes from the map on disk, once, on the first tick.
   *
   * Everything downstream already works off knownNodes — bestRememberedNode walks
   * back to nodes out of sight and ages their respawn timers forward — so seeding
   * it is all this takes: a restarted bot starts with every node the team has ever
   * found instead of an empty map. Only nodes we would actually mine are taken,
   * judged the same way as a visible one.
   *
   * Anything seen this run wins, since rememberVisibleNodes runs straight after.
   */
  private seedFromWorldMemory(state: MessageProtocol.GameState): void {
    if (this.seeded) {
      return;
    }
    this.seeded = true;

    let taken = 0;
    for (const node of WorldMemory.knownResources(state.Bot?.Position ?? new MessageProtocol.Position(0, 0))) {
      if (this.knownNodes.has(node.id)) {
        continue;
      }

      // matchesResourceKind wants a Resource; the name and loot item are all it
      // reads, and both are on the record.
      const probe = new MessageProtocol.Resource();
      probe.Name = node.name;
      probe.LootItem = node.lootItem;

      this.knownNodes.set(node.id, {
        name: node.name,
        position: node.position,
        amount: node.lastAmount,
        respawnTicks: node.lastRemainingTicks,
        seenTick: node.lastSeenTick,
        wanted: this.wanted(probe),
      });
      taken++;
    }

    if (taken > 0) {
      console.log(`[${this.tag}] Starting with ${taken} node(s) remembered from the map on disk.`);
    }
  }

  /** Record everything in sight, so we can come back after a respawn. */
  private rememberVisibleNodes(state: MessageProtocol.GameState): void {
    const machineTiles = new Set(
      state.VisibleStructures.filter(
        (structure) => structure.Type === "Pump" || structure.Type === "Extractor",
      ).map((structure) => `${structure.Position.X},${structure.Position.Y}`),
    );

    for (const resource of state.VisibleResources) {
      this.knownNodes.set(resource.Id, {
        name: resource.Name,
        position: resource.Position,
        amount: resource.CurrentAmount,
        respawnTicks: resource.RemainingTicks,
        seenTick: state.CurrentTick,
        wanted: this.wanted(resource),
      });

      // Both directions on purpose: a node we can see with no machine on it is
      // fair game again, so a pump that got destroyed does not blacklist it for
      // the rest of the match.
      const key = `${resource.Position.X},${resource.Position.Y}`;
      if (machineTiles.has(key)) {
        if (!this.machineNodes.has(resource.Id)) {
          console.log(
            `[${this.tag}] ${resource.Name} at ${key} has a machine on it, leaving it to run itself.`,
          );
        }
        this.machineNodes.add(resource.Id);
      } else {
        this.machineNodes.delete(resource.Id);
      }
    }
  }

  /** True when this node is off limits: a machine works it, or it is refilling. */
  private isSkipped(
    id: number,
    remainingTicks: number,
  ): boolean {
    if (GathererBehaviour.SKIP_MACHINE_NODES && this.machineNodes.has(id)) {
      return true;
    }
    return GathererBehaviour.SKIP_REGENERATING && remainingTicks > 0;
  }

  /**
   * Nearest node we remember that should be worth the walk: either it had
   * stock when we left it, or it was empty long enough ago that its respawn
   * timer has run out. Nodes we can currently see are skipped, since the
   * caller has already established none of those are worth mining.
   */
  private bestRememberedNode(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): { name: string; position: MessageProtocol.Position } | null {
    const visible = new Set(state.VisibleResources.map((r) => r.Id));
    let best: { name: string; position: MessageProtocol.Position } | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const [id, node] of this.knownNodes) {
      if (visible.has(id)) {
        continue;
      }
      if (!node.wanted) {
        continue;
      }

      const ignoredUntil = this.ignoredNodes.get(id);
      if (ignoredUntil !== undefined && ignoredUntil > state.CurrentTick) {
        continue;
      }
      if (TeamClaims.takenByOther(id, this.tag, state.CurrentTick)) {
        continue;
      }
      if (GathererBehaviour.SKIP_MACHINE_NODES && this.machineNodes.has(id)) {
        continue;
      }

      // RemainingTicks is what the server told us at the time we looked.
      const age = state.CurrentTick - node.seenTick;
      const wait = node.respawnTicks > 0 ? node.respawnTicks : GathererBehaviour.RESPAWN_GUESS;
      if (node.amount <= 0 && age < wait) {
        continue;
      }
      // Same rule as for visible nodes, aged forward: it was still refilling
      // when we saw it, and by our reckoning it has not finished yet.
      if (GathererBehaviour.SKIP_REGENERATING && age < node.respawnTicks) {
        continue;
      }

      const distance = this.manhattan(pos, node.position);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { name: node.name, position: node.position };
      }
    }

    return best;
  }

  private logRevisit(
    state: MessageProtocol.GameState,
    node: { name: string; position: MessageProtocol.Position },
  ): void {
    const key = `${node.position.X},${node.position.Y}`;
    if (this.lastRevisitKey === key) {
      return;
    }
    this.lastRevisitKey = key;
    console.log(
      `[${this.tag}] Nothing in sight; heading back to the ${node.name} at ` +
        `${node.position.X},${node.position.Y} (should have respawned).`,
    );
  }

  /**
   * Sweep in one of the four directions looking for a fresh patch. Commits to
   * a heading for a while so it actually covers ground, and avoids whichever
   * way a teammate is already going.
   */
  private explore(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    // Blocked or leg finished: pick a fresh heading.
    if (this.mover.lastMoveRefused) {
      this.exploreTicksLeft = 0;
    }

    if (!this.exploreDirection || this.exploreTicksLeft <= 0) {
      this.exploreDirection = this.chooseExploreDirection(state, pos);
      this.exploreTicksLeft = GathererBehaviour.EXPLORE_LEG;
      console.log(`[${this.tag}] Nothing to mine here, exploring ${this.exploreDirection}.`);
    }

    this.exploreTicksLeft--;
    TeamScouting.reserve(this.tag, this.exploreDirection, state.CurrentTick);

    const vector = DIRECTION_VECTORS[this.exploreDirection];
    return this.mover.step(
      state,
      pos,
      new MessageProtocol.Position(
        pos.X + vector.x * GathererBehaviour.SEEK_AHEAD,
        pos.Y + vector.y * GathererBehaviour.SEEK_AHEAD,
      ),
    );
  }

  /**
   * Prefer a direction that no teammate has reserved and that does not point
   * at an ally we can see, so the team fans out instead of clumping. Filters
   * are relaxed one at a time rather than ever returning nothing.
   */
  private chooseExploreDirection(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): Direction {
    const taken = TeamScouting.taken(this.tag, state.CurrentTick);
    const towardAlly = new Set<Direction>();

    for (const ally of this.visibleAllies(state)) {
      towardAlly.add(this.dominantDirection(pos, ally));
    }

    const free = ALL_DIRECTIONS.filter((d) => !taken.has(d) && !towardAlly.has(d));
    const options =
      free.filter((d) => d !== this.exploreDirection).length > 0
        ? free.filter((d) => d !== this.exploreDirection)
        : free.length > 0
          ? free
          : ALL_DIRECTIONS.filter((d) => !taken.has(d));

    const candidates = options.length > 0 ? options : ALL_DIRECTIONS;

    // Rotate so a bot that keeps exploring does not pick the same way twice,
    // and so two bots with identical inputs still stagger.
    const seed = [...this.tag].reduce((total, ch) => total + ch.charCodeAt(0), 0);
    return candidates[(this.exploreCount++ + seed) % candidates.length];
  }

  private visibleAllies(state: MessageProtocol.GameState): MessageProtocol.Position[] {
    const seen = new Set<number>();
    const result: MessageProtocol.Position[] = [];

    for (const player of [...state.TeamPlayers, ...state.VisiblePlayers]) {
      if (player.IsSelf || seen.has(player.PlayerId)) {
        continue;
      }
      if (!player.IsAlly && player.TeamId !== state.Team?.Id) {
        continue;
      }
      seen.add(player.PlayerId);
      result.push(player.Position);
    }

    return result;
  }

  private dominantDirection(
    from: MessageProtocol.Position,
    to: MessageProtocol.Position,
  ): Direction {
    const dx = to.X - from.X;
    const dy = to.Y - from.Y;

    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx >= 0 ? "right" : "left";
    }
    return dy >= 0 ? "down" : "up";
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

    // Keep our reservation alive while we are on the way to it or mining it.
    if (this.targetId !== null) {
      TeamClaims.claim(this.targetId, this.tag, state.CurrentTick);
    }

    if (carried >= GathererBehaviour.CARRY_TARGET || this.slotsFull(state.Bot)) {
      console.log(`[${this.tag}] Carrying ${carried}, heading back to base.`);
      return this.startReturn(state, pos, carried);
    }

    // A pump or extractor can land on our node while we walk to it (a teammate
    // placing one, or an enemy). Drop it and find another rather than race a
    // machine for the same stock.
    if (
      GathererBehaviour.SKIP_MACHINE_NODES &&
      this.targetId !== null &&
      this.machineNodes.has(this.targetId)
    ) {
      console.log(`[${this.tag}] Node ${this.targetId} now has a machine on it, picking another.`);
      this.releaseClaim();
      this.targetId = null;
      this.targetPosition = null;
      this.lastNodeAmount = null;
      this.idleTicks = 0;
      this.phase = "seek";
      return this.seek(state, pos);
    }

    // Node tiles are never walkable, so "close enough" means adjacent. Never
    // try to stand on the node itself: the move is refused and we would spend
    // every tick bumping into it instead of ever calling Gather.
    //
    // Adjacent means orthogonally adjacent, hence manhattan and not chebyshev.
    // A diagonal is chebyshev distance 1, and stopping there gets us a node we
    // cannot reach: we would sit and mine thin air until STUCK_TICKS wrote off
    // a node that was fine all along.
    const node = state.VisibleResources.find((r) => r.Id === this.targetId);
    const distance = this.manhattan(pos, target);

    // Checked before the walk, not after it: a node can be emptied by someone
    // else while we are still on our way, and finishing the trip to an empty
    // node wastes the whole journey. A node that merely dropped out of vision
    // is not treated as gone while we are still travelling, since we remember
    // where it was.
    const ranOut = node ? node.CurrentAmount <= 0 : distance <= 1;
    if (ranOut) {
      console.log(
        `[${this.tag}] Node ${this.targetId} is empty` +
          (carried > 0
            ? `, taking ${carried} back to base.`
            : `, picking another one${distance > 1 ? " (was still walking to it)" : ""}.`),
      );
      this.releaseClaim();
      this.targetId = null;
      this.targetPosition = null;
      this.lastNodeAmount = null;
      if (carried > 0) {
        return this.startReturn(state, pos, carried);
      }
      this.phase = "seek";
      return this.seek(state, pos);
    }

    if (distance > 1) {
      return this.mover.step(state, pos, this.approachTile(state, pos, target));
    }

    if (!node) {
      // Unreachable: adjacent with no visible node is handled by ranOut above.
      this.phase = "seek";
      return this.seek(state, pos);
    }

    // Mining may take several ticks per item, so a draining node counts as
    // progress even before anything lands in our inventory.
    const progressed =
      carried > this.lastCarried ||
      (this.lastNodeAmount !== null && node.CurrentAmount < this.lastNodeAmount);

    if (progressed) {
      this.idleTicks = 0;
    } else if (++this.idleTicks > GathererBehaviour.STUCK_TICKS) {
      console.log(
        `[${this.tag}] Node ${this.targetId} gave nothing in ${GathererBehaviour.STUCK_TICKS} ticks, ` +
          "ignoring it and looking elsewhere.",
      );
      this.ignoredNodes.set(node.Id, state.CurrentTick + GathererBehaviour.NODE_IGNORE_TTL);
      this.releaseClaim();
      this.targetId = null;
      this.targetPosition = null;
      this.lastNodeAmount = null;
      this.idleTicks = 0;
      this.phase = "seek";
      return this.seek(state, pos);
    }

    this.lastCarried = carried;
    this.lastNodeAmount = node.CurrentAmount;

    return new MessageProtocol.GatherNodeAction(target);
  }

  /**
   * Where to actually walk when mining a node: the closest tile beside it we
   * could stand on, not the node tile itself. Aiming at the node has the
   * pathfinder route us to whichever tile it reaches first, diagonals included,
   * and a diagonal is no use for gathering.
   *
   * Falls back to the node when none of the four look free — the pathfinder
   * still closes the distance, and something will have moved by the time we
   * get there.
   */
  private approachTile(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    node: MessageProtocol.Position,
  ): MessageProtocol.Position {
    const sides = ALL_DIRECTIONS.map((direction) => {
      const vector = DIRECTION_VECTORS[direction];
      return new MessageProtocol.Position(node.X + vector.x, node.Y + vector.y);
    })
      .filter((side) => PathfindingMover.isPassable(state.getTileAt(side)))
      .sort((a, b) => this.manhattan(pos, a) - this.manhattan(pos, b));

    return sides[0] ?? node;
  }

  /** Walk home and drop everything into storage, then start over. */
  private returnToBase(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    carried: number,
  ): MessageProtocol.ActionBase | null {
    if (carried === 0) {
      // Either we unloaded at the ship or companions took the lot on the way.
      console.log(`[${this.tag}] Pack empty, back to work.`);
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
      console.log(`[${this.tag}] No base in state, cannot deposit.`);
      return null;
    }

    if (!this.depositSpots) {
      this.depositSpots = BaseGeometry.interiorTiles(base);
    }

    let spot = this.depositSpots[this.probeIndex];
    if (pos.X !== spot.X || pos.Y !== spot.Y) {
      // The ship is bigger than one tile and its inside is not walkable, so a
      // candidate tile in the middle is unreachable. If we are wedged and the
      // ship is right there, drop from where we stand instead of walking.
      if (
        this.mover.lastMoveRefused &&
        BaseGeometry.distanceTo(base, pos) <= GathererBehaviour.NEAR_BASE_RANGE
      ) {
        console.log(
          `[${this.tag}] Blocked at ${pos.X},${pos.Y} next to the ship. Depositing from here ` +
            `instead of walking to ${spot.X},${spot.Y}.`,
        );
        spot = new MessageProtocol.Position(pos.X, pos.Y);
        this.depositSpots[this.probeIndex] = spot;
        this.depositTicks = 0;
      } else {
        return this.mover.step(state, pos, spot);
      }
    }

    if (this.depositTicks === 0) {
      this.logDepositDiagnostic(state, pos, base, carried, spot);
    }

    // The pack got lighter, so this tile works even if it only takes one stack
    // per action. Stay put and keep unloading instead of probing elsewhere.
    if (this.lastDepositCarried !== null && carried < this.lastDepositCarried) {
      if (!this.depositLocked) {
        console.log(`[${this.tag}] Deposit accepted at ${spot.X},${spot.Y}, staying until empty.`);
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
    if (++this.depositTicks > GathererBehaviour.DEPOSIT_TRIES) {
      this.depositTicks = 0;
      this.probeIndex = (this.probeIndex + 1) % this.depositSpots.length;
      const next = this.depositSpots[this.probeIndex];
      console.log(
        `[${this.tag}] Deposit refused at ${spot.X},${spot.Y}. Trying ${next.X},${next.Y} ` +
          `(${this.probeIndex + 1}/${this.depositSpots.length}).`,
      );
      if (this.probeIndex === 0) {
        console.log(
          `[${this.tag}] Every base tile refused so far. Check [SERVER] Error lines above.`,
        );
      }
      return null;
    }

    return new MessageProtocol.DepositToBaseAction();
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

    console.log(`=== [${this.tag}] deposit diagnostic ===`);
    console.log(`  bot at        : ${pos.X},${pos.Y}  (probing spot ${spot.X},${spot.Y})`);
    console.log(`  carrying      : ${carried} -> ${inventory}`);
    console.log(`  base.Position : ${base.Position.X},${base.Position.Y} ${base.Width}x${base.Height}`);
    console.log(`  base storage  : ${base.StorageSlots} slots, ${base.Inventory.length} stacks`);
    console.log(`  team id       : ${state.Team?.Id}`);
    console.log(
      `  tile here     : ${tile ? `${tile.Terrain}/${tile.Zone} owner=${tile.ZoneOwnerTeamId} structure=${tile.HasStructure}` : "NOT VISIBLE"}`,
    );
    console.log(`  structures<=3 : ${nearby.length ? nearby.join(", ") : "none"}`);
    console.log(`  atBase()      : ${BaseGeometry.isAtBase(state, pos, base)}`);
    console.log("================================");
  }

  private startReturn(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    carried: number,
  ): MessageProtocol.ActionBase | null {
    this.phase = "return";
    this.releaseClaim();
    this.targetId = null;
    this.targetPosition = null;
    this.lastNodeAmount = null;
    this.idleTicks = 0;
    this.depositLocked = false;
    this.lastDepositCarried = null;
    return this.returnToBase(state, pos, carried);
  }

  private manhattan(a: MessageProtocol.Position, b: MessageProtocol.Position): number {
    return Math.abs(a.X - b.X) + Math.abs(a.Y - b.Y);
  }

  /** @param mustHaveStock skip nodes that are currently mined out. */
  private nearestResource(
    from: MessageProtocol.Position,
    resources: MessageProtocol.Resource[],
    mustHaveStock: boolean,
    tick: number,
  ): MessageProtocol.Resource | null {
    let best: MessageProtocol.Resource | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const resource of resources) {
      if (!this.wanted(resource)) {
        continue;
      }
      if (mustHaveStock && resource.CurrentAmount <= 0) {
        continue;
      }

      // Only when looking for something to mine: the mustHaveStock=false pass
      // exists to report which node we are waiting on, and that node is by
      // definition one with a timer running.
      if (mustHaveStock && this.isSkipped(resource.Id, resource.RemainingTicks)) {
        continue;
      }

      const ignoredUntil = this.ignoredNodes.get(resource.Id);
      if (ignoredUntil !== undefined && ignoredUntil > tick) {
        continue;
      }

      // Leave nodes our teammate is already working; there is only room for
      // one bot next to a node and two of us there just block each other.
      if (TeamClaims.takenByOther(resource.Id, this.tag, tick)) {
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

  /**
   * Throttled report of why nothing is being mined. Also prints the raw
   * amounts: if every node shows 0/0 the field is not being parsed rather
   * than the nodes genuinely being empty.
   */
  private logEmptyNodes(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    waitingOn: MessageProtocol.Resource,
  ): void {
    if (state.CurrentTick - this.lastEmptyLogTick < GathererBehaviour.EMPTY_LOG_EVERY) {
      return;
    }
    this.lastEmptyLogTick = state.CurrentTick;

    const summary = state.VisibleResources.slice(0, 6)
      .map((r) => `${r.Name} ${r.CurrentAmount}/${r.Capacity} respawn=${r.RemainingTicks}`)
      .join(" | ");

    console.log(
      `[${this.tag}] ${state.VisibleResources.length} node(s) visible, none worth mining ` +
        `(empty, refilling, or machine-worked). ` +
        `Waiting at ${pos.X},${pos.Y} for ${waitingOn.Name} at ` +
        `${waitingOn.Position.X},${waitingOn.Position.Y}. [${summary}]`,
    );
  }

  private releaseClaim(): void {
    if (this.targetId !== null) {
      TeamClaims.release(this.targetId, this.tag);
    }
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

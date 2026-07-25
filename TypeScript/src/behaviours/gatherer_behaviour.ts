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

type Phase = "seek" | "gather" | "return";

/**
 * Mine the nearest node and ship the load home on companions, so the bot stays
 * on the node instead of walking back and forth. Falls back to hauling it home
 * itself when that is cheaper, or when every companion slot is busy.
 */
export class GathererBehaviour implements IBehaviour {
  public readonly name = "gatherer";

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
  /** Carried count on the tick we sent, so the next tick can measure the drop. */
  private sentAtCarried: number | null = null;
  private sends = 0;
  private refusedSends = 0;
  /** Every node we have ever seen, so respawns out of vision are not lost. */
  private readonly knownNodes = new Map<
    number,
    {
      name: string;
      position: MessageProtocol.Position;
      amount: number;
      respawnTicks: number;
      seenTick: number;
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
    this.rememberVisibleNodes(state);

    const pos = state.Bot.Position;
    const carried = this.carriedCount(state.Bot.Inventory);

    if (GathererBehaviour.FORCE_DEPOSIT) {
      return this.forceDeposit(state, pos, carried);
    }

    // Let the mover see whether last tick's move actually happened.
    this.mover.observe(state, pos);

    // How much a companion took tells us its capacity, so measure it first.
    this.measureCapacity(carried);

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
      return null;
    }

    // Hold one more item than we think fits, so every send finds out whether
    // the capacity has been researched up. Costs nothing while we are mining
    // anyway, and converges on the real number within a few sends. Skipped once
    // the pack is full, or when we are already walking home with a load.
    //
    // Never probe past a load we would carry home, or the walk-home check below
    // fires first and we set off on a trip we did not need.
    const probeLoad = Math.min(
      this.companionCapacity + 1,
      GathererBehaviour.CARRY_TARGET,
    );
    if (
      carried < probeLoad &&
      !this.slotsFull(state.Bot) &&
      this.phase !== "return"
    ) {
      return null;
    }

    // Every slot busy. Nothing to do but keep mining, and if the pack is full
    // the caller falls through to walking it home instead of idling here.
    if (state.Team.CompanionNumber >= state.Team.CompanionSlots) {
      return null;
    }

    this.sentAtCarried = carried;
    this.sends++;
    console.log(
      `[${this.tag}] Companion ${this.sends} away with up to ${this.companionCapacity} of ${carried} ` +
        `(${state.Team.CompanionNumber + 1}/${state.Team.CompanionSlots} slots in use).`,
    );

    return new MessageProtocol.SendCompanionAction();
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
   */
  private measureCapacity(carried: number): void {
    if (this.sentAtCarried === null) {
      return;
    }

    const shipped = this.sentAtCarried - carried;
    this.sentAtCarried = null;

    if (shipped > this.companionCapacity) {
      console.log(
        `[${this.tag}] A companion carried ${shipped} items, so capacity is now ${shipped}.`,
      );
      this.companionCapacity = shipped;
      this.refusedSends = 0;
      return;
    }

    if (shipped <= 0 && ++this.refusedSends === 3) {
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

  /** Record everything in sight, so we can come back after a respawn. */
  private rememberVisibleNodes(state: MessageProtocol.GameState): void {
    for (const resource of state.VisibleResources) {
      this.knownNodes.set(resource.Id, {
        name: resource.Name,
        position: resource.Position,
        amount: resource.CurrentAmount,
        respawnTicks: resource.RemainingTicks,
        seenTick: state.CurrentTick,
      });
    }
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

      const ignoredUntil = this.ignoredNodes.get(id);
      if (ignoredUntil !== undefined && ignoredUntil > state.CurrentTick) {
        continue;
      }
      if (TeamClaims.takenByOther(id, this.tag, state.CurrentTick)) {
        continue;
      }

      // RemainingTicks is what the server told us at the time we looked.
      const age = state.CurrentTick - node.seenTick;
      const wait = node.respawnTicks > 0 ? node.respawnTicks : GathererBehaviour.RESPAWN_GUESS;
      if (node.amount <= 0 && age < wait) {
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
      if (mustHaveStock && resource.CurrentAmount <= 0) {
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
      `[${this.tag}] ${state.VisibleResources.length} node(s) visible, none with stock. ` +
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

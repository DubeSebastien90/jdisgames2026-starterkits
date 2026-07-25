import * as MessageProtocol from "../client/message_protocol";
import { IBehaviour } from "./ibehaviour";
import { TeamClaims } from "../team/team_claims";
import {
  ALL_DIRECTIONS,
  DIRECTION_VECTORS,
  Direction,
  TeamScouting,
} from "../team/team_scouting";

type Phase = "seek" | "gather" | "return";

/**
 * Mine the nearest node, haul the load back to the ship, repeat.
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
  // Pathfinding: how far from the bot to search, and a hard cap on the work.
  private static readonly PATH_RADIUS = 25;
  private static readonly PATH_MAX_NODES = 4000;
  // A tile that refused us is avoided for this long. Expires because the
  // blocker is often another bot, which will have moved on by then.
  private static readonly BLOCK_TTL = 30;
  // Much shorter when the blocker was another bot: it walks away on its own,
  // and avoiding its tile for 30 ticks pushes us into silly detours.
  private static readonly ENTITY_BLOCK_TTL = 3;
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
  // Master switch for the sidestep-when-blocked behaviour below. Off: the
  // pathfinder covers this now. Flip to true to re-enable.
  private static readonly USE_DETOUR = false;
  // Sidestep this many tiles when a move gets refused (usually a resource node
  // sitting in the way), then go back to normal navigation.
  private static readonly DETOUR_STEPS = 5;
  // Each repeated failure sidesteps another DETOUR_STEPS tiles, up to this many.
  private static readonly MAX_DETOUR_ATTEMPTS = 4;

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
  private posBeforeMove: MessageProtocol.Position | null = null;
  private lastMoveTarget: MessageProtocol.Position | null = null;
  private detourRemaining = 0;
  private detourDelta: { x: number; y: number } | null = null;
  private detourSide = 1;
  private detourAttempts = 0;
  private depositLocked = false;
  private lastDepositCarried: number | null = null;
  private moveRefused = false;
  private refusedFrom: MessageProtocol.Position | null = null;
  private refusedTo: MessageProtocol.Position | null = null;
  private readonly blockedUntil = new Map<string, number>();
  private lastEmptyLogTick = -GathererBehaviour.EMPTY_LOG_EVERY;
  private readonly ignoredNodes = new Map<number, number>();
  private exploreDirection: Direction | null = null;
  private exploreTicksLeft = 0;
  private exploreCount = 0;
  private lastRevisitKey: string | null = null;
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

    // Did last tick's move actually happen?
    this.updateMoveOutcome(state, pos);

    if (GathererBehaviour.USE_DETOUR) {
      this.checkIfStuck();
    }

    // A detour in progress outranks everything else until it finishes.
    if (GathererBehaviour.USE_DETOUR && this.detourRemaining > 0 && this.detourDelta) {
      this.detourRemaining--;
      const side = this.detourDelta;
      console.log(`[${this.tag}] Detour step, ${this.detourRemaining} left.`);
      return this.move(pos, new MessageProtocol.Position(pos.X + side.x, pos.Y + side.y));
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
   * If the move we asked for last tick left us on the same tile, something is
   * in the way (usually a resource node). Sidestep perpendicular to whatever
   * direction we were trying to go.
   */
  private checkIfStuck(): void {
    const from = this.refusedFrom;
    const to = this.refusedTo;
    if (!this.moveRefused || !from || !to) {
      return;
    }

    // Wedged during the sidestep itself: back out the other way.
    if (this.detourRemaining > 0 && this.detourDelta) {
      this.detourDelta = { x: -this.detourDelta.x, y: -this.detourDelta.y };
      this.detourRemaining = GathererBehaviour.DETOUR_STEPS;
      console.log(`[${this.tag}] Sidestep blocked too, reversing.`);
      return;
    }

    // Blocked again right after a detour means the obstacle is longer than we
    // thought, so keep going the same way and reach further each time.
    this.detourAttempts = Math.min(
      this.detourAttempts + 1,
      GathererBehaviour.MAX_DETOUR_ATTEMPTS,
    );

    const wasHorizontal = to.X !== from.X;
    this.detourDelta = wasHorizontal
      ? { x: 0, y: this.detourSide }
      : { x: this.detourSide, y: 0 };
    this.detourRemaining = GathererBehaviour.DETOUR_STEPS * this.detourAttempts;

    console.log(
      `[${this.tag}] Move to ${to.X},${to.Y} refused. Sidestepping ${this.detourRemaining} ` +
        `tiles (${this.detourDelta.x},${this.detourDelta.y}).`,
    );
  }

  /**
   * Compare where we are against the move we asked for last tick. Runs every
   * tick regardless of USE_DETOUR, because the deposit logic needs to know
   * when we are wedged too.
   */
  private updateMoveOutcome(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): void {
    const tick = state.CurrentTick;
    const from = this.posBeforeMove;
    const to = this.lastMoveTarget;
    this.posBeforeMove = null;
    this.lastMoveTarget = null;
    this.moveRefused = false;
    this.refusedFrom = null;
    this.refusedTo = null;

    if (!from || !to) {
      return;
    }

    if (pos.X === from.X && pos.Y === from.Y) {
      this.moveRefused = true;
      this.refusedFrom = from;
      this.refusedTo = to;

      // Remember it so the next path plans around it. A bot in the way clears
      // in a couple of ticks, while a tree does not, so do not sulk about a
      // teammate's tile for as long as we would about scenery.
      const blocker = state.getTileAt(to);
      const ttl = blocker?.HasEntity
        ? GathererBehaviour.ENTITY_BLOCK_TTL
        : GathererBehaviour.BLOCK_TTL;
      this.blockedUntil.set(`${to.X},${to.Y}`, tick + ttl);
      return;
    }

    // Moving normally again, so the obstacle is behind us.
    if (this.detourRemaining === 0) {
      this.detourAttempts = 0;
    }
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
        `atBase=${base ? this.atBase(state, pos, base) : "n/a"}`,
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
        return this.stepToward(state, pos, remembered.position);
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
    if (this.moveRefused) {
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
    return this.stepToward(
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
    const node = state.VisibleResources.find((r) => r.Id === this.targetId);
    const distance = this.chebyshev(pos, target);

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
      return this.stepToward(state, pos, target);
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

  /** Walk home and drop everything into storage, then start over. */
  private returnToBase(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    carried: number,
  ): MessageProtocol.ActionBase | null {
    if (carried === 0) {
      console.log(`[${this.tag}] Deposited, back to work.`);
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
      this.depositSpots = this.candidateDepositSpots(base);
    }

    let spot = this.depositSpots[this.probeIndex];
    if (pos.X !== spot.X || pos.Y !== spot.Y) {
      // The ship is bigger than one tile and its inside is not walkable, so a
      // candidate tile in the middle is unreachable. If we are wedged and the
      // ship is right there, drop from where we stand instead of walking.
      if (this.moveRefused && this.nearBase(pos, base)) {
        console.log(
          `[${this.tag}] Blocked at ${pos.X},${pos.Y} next to the ship. Depositing from here ` +
            `instead of walking to ${spot.X},${spot.Y}.`,
        );
        spot = new MessageProtocol.Position(pos.X, pos.Y);
        this.depositSpots[this.probeIndex] = spot;
        this.depositTicks = 0;
      } else {
        return this.stepToward(state, pos, spot);
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

  /**
   * Are we touching the ship? Measured against the base rectangle read both as
   * top-left anchored and as centre anchored, since we do not know which it is.
   */
  private nearBase(
    pos: MessageProtocol.Position,
    base: MessageProtocol.BaseInfo,
  ): boolean {
    const width = Math.max(base.Width, 1);
    const height = Math.max(base.Height, 1);

    const distanceToRect = (originX: number, originY: number): number => {
      const dx = Math.max(originX - pos.X, 0, pos.X - (originX + width - 1));
      const dy = Math.max(originY - pos.Y, 0, pos.Y - (originY + height - 1));
      return Math.max(dx, dy);
    };

    const distance = Math.min(
      distanceToRect(base.Position.X, base.Position.Y),
      distanceToRect(
        base.Position.X - Math.floor(width / 2),
        base.Position.Y - Math.floor(height / 2),
      ),
    );

    return distance <= GathererBehaviour.NEAR_BASE_RANGE;
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
    console.log(`  atBase()      : ${this.atBase(state, pos, base)}`);
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

  /**
   * One tile per tick. Routes around trees, hulls and other bots using the
   * tiles we can currently see, falling back to a straight X-then-Y step when
   * no route is found (target out of vision, or we are boxed in).
   */
  private stepToward(
    state: MessageProtocol.GameState,
    from: MessageProtocol.Position,
    to: MessageProtocol.Position,
  ): MessageProtocol.MoveAction {
    const planned = this.findFirstStep(state, from, to);
    if (planned) {
      return this.move(from, planned);
    }

    const deltaX = to.X - from.X;
    const deltaY = to.Y - from.Y;

    return this.move(
      from,
      deltaX !== 0
        ? new MessageProtocol.Position(from.X + Math.sign(deltaX), from.Y)
        : new MessageProtocol.Position(from.X, from.Y + Math.sign(deltaY)),
    );
  }

  /**
   * Breadth-first search over visible tiles, re-run every tick so moving
   * obstacles (other bots) are handled naturally. Returns the first step of
   * the route, or of the best partial route when the goal is unreachable.
   */
  private findFirstStep(
    state: MessageProtocol.GameState,
    from: MessageProtocol.Position,
    to: MessageProtocol.Position,
  ): MessageProtocol.Position | null {
    const startKey = `${from.X},${from.Y}`;
    const goalKey = `${to.X},${to.Y}`;
    if (startKey === goalKey) {
      return null;
    }

    const positions = new Map<string, MessageProtocol.Position>([[startKey, from]]);
    const cameFrom = new Map<string, string>();
    const visited = new Set<string>([startKey]);
    const queue: MessageProtocol.Position[] = [from];

    let head = 0;
    let bestKey = startKey;
    let bestDistance = this.manhattan(from, to);

    while (head < queue.length && head < GathererBehaviour.PATH_MAX_NODES) {
      const current = queue[head++];
      const currentKey = `${current.X},${current.Y}`;

      const distance = this.manhattan(current, to);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestKey = currentKey;
      }

      if (currentKey === goalKey) {
        bestKey = currentKey;
        break;
      }

      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = new MessageProtocol.Position(current.X + dx, current.Y + dy);
        const nextKey = `${next.X},${next.Y}`;

        if (visited.has(nextKey)) {
          continue;
        }
        if (
          Math.abs(next.X - from.X) > GathererBehaviour.PATH_RADIUS ||
          Math.abs(next.Y - from.Y) > GathererBehaviour.PATH_RADIUS
        ) {
          continue;
        }
        if (nextKey !== goalKey && !this.isWalkable(state, next)) {
          continue;
        }

        visited.add(nextKey);
        positions.set(nextKey, next);
        cameFrom.set(nextKey, currentKey);
        queue.push(next);
      }
    }

    if (bestKey === startKey) {
      return null;
    }

    // Walk the parent chain back until the tile whose parent is where we stand.
    let key = bestKey;
    while (cameFrom.get(key) !== startKey) {
      const parent = cameFrom.get(key);
      if (!parent) {
        return null;
      }
      key = parent;
    }

    return positions.get(key) ?? null;
  }

  /**
   * Trees are resource nodes, so HasResource blocks. Unknown tiles are treated
   * as open, otherwise the bot could never path outside its own vision.
   */
  private isWalkable(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): boolean {
    const blockedUntil = this.blockedUntil.get(`${pos.X},${pos.Y}`);
    if (blockedUntil !== undefined && blockedUntil > state.CurrentTick) {
      return false;
    }

    const tile = state.getTileAt(pos);
    if (!tile) {
      return true;
    }

    const category = tile.TerrainCategory.toLowerCase();
    if (category.includes("liquid") || category.includes("water")) {
      return false;
    }

    return !tile.HasResource && !tile.HasStructure && !tile.HasEntity;
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

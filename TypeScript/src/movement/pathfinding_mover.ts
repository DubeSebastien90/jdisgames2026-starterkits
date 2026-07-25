import * as MessageProtocol from "../client/message_protocol";
import { IMover } from "./imover";
import { TileClaims } from "./tile_claims";

/**
 * Breadth-first search over the tiles we can currently see, re-planned every
 * tick so moving obstacles (other bots) sort themselves out. Remembers tiles
 * that refused us, briefly, so it stops walking into them.
 *
 * Every bot gets its own instance, but they coordinate through TileClaims so
 * teammates route around each other instead of colliding.
 */
export class PathfindingMover implements IMover {
  public readonly name = "pathfinding";

  // How far from the bot to search, and a hard cap on the work per tick.
  private static readonly PATH_RADIUS = 25;
  private static readonly PATH_MAX_NODES = 4000;
  // A tile that refused us is avoided for this long.
  private static readonly BLOCK_TTL = 30;
  // Much shorter when the blocker was another bot: it walks away on its own,
  // and avoiding its tile for 30 ticks pushes us into silly detours.
  private static readonly ENTITY_BLOCK_TTL = 3;
  // Ticks we will stand and wait for a teammate to clear a tile before walking
  // into it anyway. Two bots facing each other in a one-tile gap would both
  // wait for the other for good, so the wait has to end somewhere: bumping
  // gets the tile marked blocked and forces a fresh plan, as it always did.
  private static readonly MAX_WAIT_TICKS = 3;

  private readonly blockedUntil = new Map<string, number>();
  private posBeforeMove: MessageProtocol.Position | null = null;
  private lastMoveTarget: MessageProtocol.Position | null = null;
  private refused = false;
  /** Who we are claiming tiles as. Read from the state, so nothing to plumb. */
  private owner = "bot";
  private waitTicks = 0;

  public get lastMoveRefused(): boolean {
    return this.refused;
  }

  /**
   * Is this a tile a bot could stand on? Public so behaviours can vet a
   * destination before walking to it without knowing how paths are planned.
   * A missing tile is one we cannot see, and unseen tiles are assumed open.
   */
  public static isPassable(tile: MessageProtocol.Tile | null | undefined): boolean {
    if (!tile) {
      return true;
    }

    const category = tile.TerrainCategory.toLowerCase();
    if (category.includes("liquid") || category.includes("water")) {
      return false;
    }

    // Trees are resource nodes, so HasResource blocks.
    return !tile.HasResource && !tile.HasStructure;
  }

  /**
   * Compare where we are against the move we asked for last tick. A tile we
   * failed to enter is remembered so the next path plans around it.
   *
   * Also where we tell the team which tile we are on. That happens here rather
   * than in step() because a behaviour that decides to stand still never calls
   * step(), and a parked bot still needs to be an obstacle to its teammate.
   */
  public observe(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): void {
    this.owner = state.Bot?.BotType || this.owner;
    TileClaims.hold(this.owner, pos, state.CurrentTick);

    const from = this.posBeforeMove;
    const to = this.lastMoveTarget;
    this.posBeforeMove = null;
    this.lastMoveTarget = null;
    this.refused = false;

    if (!from || !to) {
      return;
    }

    if (pos.X === from.X && pos.Y === from.Y) {
      this.refused = true;
      const blocker = state.getTileAt(to);
      const ttl = blocker?.HasEntity
        ? PathfindingMover.ENTITY_BLOCK_TTL
        : PathfindingMover.BLOCK_TTL;
      this.blockedUntil.set(`${to.X},${to.Y}`, state.CurrentTick + ttl);
    }
  }

  /**
   * One tile per tick. Falls back to a straight X-then-Y step when no route is
   * found (target out of vision, or we are boxed in), so it never does worse
   * than walking blindly.
   */
  public step(
    state: MessageProtocol.GameState,
    from: MessageProtocol.Position,
    to: MessageProtocol.Position,
  ): MessageProtocol.MoveAction | null {
    if (from.X === to.X && from.Y === to.Y) {
      return null;
    }

    // A teammate's tile is avoided when there is another way round.
    const planned = this.findFirstStep(state, from, to, true);
    if (planned) {
      return this.move(state, from, planned);
    }

    // No way round, so plan through them instead: a bot queued behind its
    // teammate in a corridor has to be allowed to path over the tile it is
    // waiting on, or it would sit there for good.
    const shared = this.findFirstStep(state, from, to, false);
    if (shared) {
      return this.stepOrWait(state, from, shared);
    }

    const deltaX = to.X - from.X;
    const deltaY = to.Y - from.Y;

    return this.stepOrWait(
      state,
      from,
      deltaX !== 0
        ? new MessageProtocol.Position(from.X + Math.sign(deltaX), from.Y)
        : new MessageProtocol.Position(from.X, from.Y + Math.sign(deltaY)),
    );
  }

  /**
   * Take the step unless a teammate is in the way. Waiting a tick costs nothing
   * when the alternative is a move the server would refuse anyway — but only
   * for so long, see MAX_WAIT_TICKS.
   */
  private stepOrWait(
    state: MessageProtocol.GameState,
    from: MessageProtocol.Position,
    to: MessageProtocol.Position,
  ): MessageProtocol.MoveAction | null {
    if (
      this.waitTicks < PathfindingMover.MAX_WAIT_TICKS &&
      TileClaims.takenByOther(this.owner, to, state.CurrentTick)
    ) {
      this.waitTicks++;
      return null;
    }

    return this.move(state, from, to);
  }

  /** Every move goes through here so observe() can tell whether it worked. */
  private move(
    state: MessageProtocol.GameState,
    from: MessageProtocol.Position,
    to: MessageProtocol.Position,
  ): MessageProtocol.MoveAction {
    TileClaims.reserve(this.owner, to, state.CurrentTick);
    this.waitTicks = 0;
    this.posBeforeMove = from;
    this.lastMoveTarget = to;
    return new MessageProtocol.MoveAction(to);
  }

  /**
   * Returns the first step of the route, or of the best partial route when the
   * goal cannot be reached from what we can see.
   *
   * @param respectClaims treat tiles a teammate holds as blocked. The caller
   * retries without it when that leaves no route at all.
   */
  private findFirstStep(
    state: MessageProtocol.GameState,
    from: MessageProtocol.Position,
    to: MessageProtocol.Position,
    respectClaims: boolean,
  ): MessageProtocol.Position | null {
    const startKey = `${from.X},${from.Y}`;
    const goalKey = `${to.X},${to.Y}`;

    const positions = new Map<string, MessageProtocol.Position>([[startKey, from]]);
    const cameFrom = new Map<string, string>();
    const visited = new Set<string>([startKey]);
    const queue: MessageProtocol.Position[] = [from];

    let head = 0;
    let bestKey = startKey;
    let bestDistance = this.manhattan(from, to);

    while (head < queue.length && head < PathfindingMover.PATH_MAX_NODES) {
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
          Math.abs(next.X - from.X) > PathfindingMover.PATH_RADIUS ||
          Math.abs(next.Y - from.Y) > PathfindingMover.PATH_RADIUS
        ) {
          continue;
        }
        if (nextKey !== goalKey && !this.isWalkable(state, next, respectClaims)) {
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
   * Terrain, then anything standing on it. Unknown tiles are treated as open,
   * otherwise the bot could never path outside its own vision.
   */
  private isWalkable(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    respectClaims: boolean,
  ): boolean {
    const blockedUntil = this.blockedUntil.get(`${pos.X},${pos.Y}`);
    if (blockedUntil !== undefined && blockedUntil > state.CurrentTick) {
      return false;
    }

    if (respectClaims && TileClaims.takenByOther(this.owner, pos, state.CurrentTick)) {
      return false;
    }

    const tile = state.getTileAt(pos);
    if (!tile) {
      return true;
    }

    return PathfindingMover.isPassable(tile) && !tile.HasEntity;
  }

  private manhattan(
    a: MessageProtocol.Position,
    b: MessageProtocol.Position,
  ): number {
    return Math.abs(a.X - b.X) + Math.abs(a.Y - b.Y);
  }
}

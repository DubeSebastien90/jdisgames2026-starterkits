import * as MessageProtocol from "../client/message_protocol";
import { IMover } from "./imover";

/**
 * Breadth-first search over the tiles we can currently see, re-planned every
 * tick so moving obstacles (other bots) sort themselves out. Remembers tiles
 * that refused us, briefly, so it stops walking into them.
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

  private readonly blockedUntil = new Map<string, number>();
  private posBeforeMove: MessageProtocol.Position | null = null;
  private lastMoveTarget: MessageProtocol.Position | null = null;
  private refused = false;

  public get lastMoveRefused(): boolean {
    return this.refused;
  }

  /**
   * Compare where we are against the move we asked for last tick. A tile we
   * failed to enter is remembered so the next path plans around it.
   */
  public observe(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): void {
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

  /** Every move goes through here so observe() can tell whether it worked. */
  private move(
    from: MessageProtocol.Position,
    to: MessageProtocol.Position,
  ): MessageProtocol.MoveAction {
    this.posBeforeMove = from;
    this.lastMoveTarget = to;
    return new MessageProtocol.MoveAction(to);
  }

  /**
   * Returns the first step of the route, or of the best partial route when the
   * goal cannot be reached from what we can see.
   */
  private findFirstStep(
    state: MessageProtocol.GameState,
    from: MessageProtocol.Position,
    to: MessageProtocol.Position,
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

  private manhattan(
    a: MessageProtocol.Position,
    b: MessageProtocol.Position,
  ): number {
    return Math.abs(a.X - b.X) + Math.abs(a.Y - b.Y);
  }
}

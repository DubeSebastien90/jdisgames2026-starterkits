import * as MessageProtocol from "../client/message_protocol";

/** Which way out of the base a tile should be looked for. */
export type Side = "right" | "left" | "up" | "down";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SIDES: Side[] = ["right", "down", "left", "up"];

/**
 * Everything about where the base actually is.
 *
 * BaseInfo.Position could be the top-left corner of the base rectangle or its
 * centre — the server does not say which — so every function here works with
 * both readings at once and hands the caller candidates to probe in order.
 *
 * Shared by every behaviour: the gatherer wants tiles to deposit on, the
 * companion farmer wants somewhere to park just outside the hull, and both need
 * to agree on where the hull is.
 */
export class BaseGeometry {
  /**
   * The base rectangle read as top-left anchored, then as centre anchored. The
   * two collapse into one when the base is a single tile.
   */
  public static rects(base: MessageProtocol.BaseInfo): Rect[] {
    const width = Math.max(base.Width, 1);
    const height = Math.max(base.Height, 1);

    const topLeft: Rect = { x: base.Position.X, y: base.Position.Y, width, height };
    const centred: Rect = {
      x: base.Position.X - Math.floor(width / 2),
      y: base.Position.Y - Math.floor(height / 2),
      width,
      height,
    };

    return topLeft.x === centred.x && topLeft.y === centred.y ? [topLeft] : [topLeft, centred];
  }

  /** Inside the hull under either reading. */
  public static contains(
    base: MessageProtocol.BaseInfo,
    pos: MessageProtocol.Position,
  ): boolean {
    return BaseGeometry.rects(base).some(
      (rect) =>
        pos.X >= rect.x &&
        pos.X < rect.x + rect.width &&
        pos.Y >= rect.y &&
        pos.Y < rect.y + rect.height,
    );
  }

  /**
   * Chebyshev distance to the hull, 0 when inside it. The nearest reading wins,
   * so this is deliberately optimistic: better to try a base action one tile
   * early than to walk into the hull looking for a tile that does not exist.
   */
  public static distanceTo(
    base: MessageProtocol.BaseInfo,
    pos: MessageProtocol.Position,
  ): number {
    let best = Number.POSITIVE_INFINITY;

    for (const rect of BaseGeometry.rects(base)) {
      const dx = Math.max(rect.x - pos.X, 0, pos.X - (rect.x + rect.width - 1));
      const dy = Math.max(rect.y - pos.Y, 0, pos.Y - (rect.y + rect.height - 1));
      best = Math.min(best, Math.max(dx, dy));
    }

    return best;
  }

  /**
   * Are we standing in our own base zone? The tile's zone is the authority when
   * we can see it, the rectangle is the fallback.
   *
   * Note this has been observed to report false on tiles where base actions
   * still succeed (the zone came back as "SafeZone"), so treat it as a hint and
   * gate actions on distanceTo() instead.
   */
  public static isAtBase(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    base: MessageProtocol.BaseInfo,
  ): boolean {
    const tile = state.getTileAt(pos);
    if (tile && tile.Zone.toLowerCase().includes("base")) {
      return tile.ZoneOwnerTeamId === null || tile.ZoneOwnerTeamId === state.Team?.Id;
    }

    return BaseGeometry.contains(base, pos);
  }

  /**
   * Every tile the hull might cover, BaseInfo.Position first since that is the
   * likeliest place for whatever accepts a deposit.
   */
  public static interiorTiles(
    base: MessageProtocol.BaseInfo,
  ): MessageProtocol.Position[] {
    const spots = new SpotList();
    spots.push(base.Position.X, base.Position.Y);

    for (const rect of BaseGeometry.rects(base)) {
      for (let y = 0; y < rect.height; y++) {
        for (let x = 0; x < rect.width; x++) {
          spots.push(rect.x + x, rect.y + y);
        }
      }
    }

    return spots.all();
  }

  /**
   * Tiles immediately outside the hull, `side` first and the middle of each
   * edge before its corners, then the other sides as fallbacks. Tiles that fall
   * inside the hull under the *other* reading are dropped, so nothing here is
   * a tile we could never stand on.
   */
  public static perimeterTiles(
    base: MessageProtocol.BaseInfo,
    side: Side = "right",
  ): MessageProtocol.Position[] {
    const spots = new SpotList();

    for (const current of [side, ...SIDES.filter((s) => s !== side)]) {
      for (const rect of BaseGeometry.rects(base)) {
        for (const pos of BaseGeometry.edgeTiles(rect, current, base.Position)) {
          spots.push(pos.X, pos.Y);
        }
      }
    }

    return spots.all().filter((pos) => !BaseGeometry.contains(base, pos));
  }

  /** The line of tiles just outside one edge, closest to `pivot` first. */
  private static edgeTiles(
    rect: Rect,
    side: Side,
    pivot: MessageProtocol.Position,
  ): MessageProtocol.Position[] {
    const tiles: MessageProtocol.Position[] = [];

    if (side === "right" || side === "left") {
      const x = side === "right" ? rect.x + rect.width : rect.x - 1;
      for (let y = rect.y; y < rect.y + rect.height; y++) {
        tiles.push(new MessageProtocol.Position(x, y));
      }
      return tiles.sort((a, b) => Math.abs(a.Y - pivot.Y) - Math.abs(b.Y - pivot.Y));
    }

    const y = side === "down" ? rect.y + rect.height : rect.y - 1;
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      tiles.push(new MessageProtocol.Position(x, y));
    }
    return tiles.sort((a, b) => Math.abs(a.X - pivot.X) - Math.abs(b.X - pivot.X));
  }
}

/** Ordered list of tiles that ignores repeats, since the readings overlap. */
class SpotList {
  private readonly seen = new Set<string>();
  private readonly spots: MessageProtocol.Position[] = [];

  public push(x: number, y: number): void {
    const key = `${x},${y}`;
    if (!this.seen.has(key)) {
      this.seen.add(key);
      this.spots.push(new MessageProtocol.Position(x, y));
    }
  }

  public all(): MessageProtocol.Position[] {
    return this.spots;
  }
}

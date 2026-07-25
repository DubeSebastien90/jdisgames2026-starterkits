export type Direction = "up" | "down" | "left" | "right";

export const DIRECTION_VECTORS: Record<Direction, { x: number; y: number }> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export const ALL_DIRECTIONS: Direction[] = ["up", "down", "left", "right"];

/**
 * Who is exploring which way, so two bots do not sweep the same direction and
 * cover the same ground twice.
 *
 * Like TeamClaims this is per-process: it works when one main.ts drives both
 * bots. When each bot runs in its own process the behaviour falls back to
 * steering away from allies it can actually see.
 */
export class TeamScouting {
  /** A heading not refreshed within this many ticks is forgotten. */
  private static readonly HEADING_TTL = 12;

  private static readonly headings = new Map<string, { dir: Direction; tick: number }>();

  public static reserve(owner: string, dir: Direction, tick: number): void {
    TeamScouting.headings.set(owner, { dir, tick });
  }

  /** Directions currently being swept by somebody other than `owner`. */
  public static taken(owner: string, tick: number): Set<Direction> {
    const result = new Set<Direction>();

    for (const [holder, heading] of TeamScouting.headings) {
      if (holder === owner) {
        continue;
      }
      if (tick - heading.tick > TeamScouting.HEADING_TTL) {
        TeamScouting.headings.delete(holder);
        continue;
      }
      result.add(heading.dir);
    }

    return result;
  }

  public static release(owner: string): void {
    TeamScouting.headings.delete(owner);
  }
}

import { Position } from "../client/message_protocol";

/**
 * Which tile each bot is standing on and which one it is stepping into, shared
 * between every mover in the process so two bots stop walking into each other.
 *
 * The tile a bot *occupies* matters as much as the one it wants: without it two
 * bots meeting head-on each try to step into the other's tile, both moves are
 * refused, and they ping-pong forever. With it neither can target the other's
 * tile, so the pathfinder routes around instead.
 *
 * Like TeamClaims this is a soft reservation, and a very short-lived one: a
 * claim is an intent for the next tick, not a booking. It lapses on its own, so
 * a bot that dies or is restarted never leaves a tile blocked behind it.
 *
 * Per-process, so it only helps while one main.ts drives both bots. With a
 * process each, movers fall back to the tile flags the server reports exactly
 * as they did before.
 */
export class TileClaims {
  /** A claim not refreshed within this many ticks is forgotten. */
  private static readonly TTL = 2;

  private static readonly claims = new Map<string, { owner: string; tick: number }>();

  /**
   * The tile `owner` is on right now. Call every tick, even when the bot is
   * standing still: a parked bot is an obstacle its teammate should walk round.
   */
  public static hold(owner: string, pos: Position, tick: number): void {
    TileClaims.prune(tick);
    TileClaims.claims.set(TileClaims.key(pos), { owner, tick });
  }

  /** The tile `owner` is trying to step into this tick. */
  public static reserve(owner: string, pos: Position, tick: number): void {
    TileClaims.claims.set(TileClaims.key(pos), { owner, tick });
  }

  /** True when somebody else is on this tile, or heading for it. */
  public static takenByOther(owner: string, pos: Position, tick: number): boolean {
    const key = TileClaims.key(pos);
    const claim = TileClaims.claims.get(key);
    if (!claim || claim.owner === owner) {
      return false;
    }

    if (tick - claim.tick > TileClaims.TTL) {
      TileClaims.claims.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Claims are keyed by tile, so a bot that keeps walking would leave a trail
   * of them behind. Swept on every hold(), which is once per bot per tick.
   */
  private static prune(tick: number): void {
    for (const [key, claim] of TileClaims.claims) {
      if (tick - claim.tick > TileClaims.TTL) {
        TileClaims.claims.delete(key);
      }
    }
  }

  private static key(pos: Position): string {
    return `${pos.X},${pos.Y}`;
  }
}

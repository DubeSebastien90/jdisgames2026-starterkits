import { Position } from "../../client/message_protocol";
import { GoalDecision, GoalStrategy, MoveStrategy } from "../../core/contracts";
import { BotContext, samePosition } from "../../core/types";
import { BotMemory } from "../../memory/bot_memory";
import { StepTowards } from "../move/step_towards";

/** Ticks of not moving before we assume the waypoint is unreachable and skip it. */
const STUCK_LIMIT = 3;

/**
 * Walks a ring of waypoints around the anchor, forever.
 *
 * `arrived` is true only on the tick a full lap completes, so the agent is free
 * to reselect between laps but will not interrupt one mid-circle.
 */
export class PatrolCircle implements GoalStrategy {
  public readonly name = "PatrolCircle";

  // ---- implementation memory: private scratch, correctly thrown away on swap ----
  private mover: MoveStrategy = new StepTowards();
  private waypoints: Position[] = [];
  private waypointIndex = 0;
  private ringAnchor: Position | null = null;

  public constructor(
    private readonly radius = 5,
    private readonly points = 12,
  ) {}

  public decide(ctx: BotContext, memory: BotMemory): GoalDecision {
    const anchor = memory.getAnchor();
    if (anchor === null) {
      return { action: null, arrived: true };
    }

    // Recompute only when an input changed (the anchor), not every tick.
    if (this.ringAnchor === null || !samePosition(this.ringAnchor, anchor)) {
      this.waypoints = buildRing(anchor, this.radius, this.points);
      this.waypointIndex = 0;
      this.ringAnchor = anchor;
    }

    const target = this.waypoints[this.waypointIndex];
    const reached = samePosition(ctx.self.Position, target);
    const blocked = memory.stuckFor() >= STUCK_LIMIT;

    if (reached || blocked) {
      if (blocked) {
        // Give up on this waypoint rather than grinding into whatever blocks it.
        memory.clearStuck();
      }

      this.waypointIndex = (this.waypointIndex + 1) % this.waypoints.length;
      const lapDone = this.waypointIndex === 0;
      const next = this.waypoints[this.waypointIndex];

      return { action: this.mover.step(ctx, next, memory), arrived: lapDone };
    }

    return { action: this.mover.step(ctx, target, memory), arrived: false };
  }

  /** Handy for logging: which waypoint we are currently walking to. */
  public currentTarget(): Position | null {
    return this.waypoints[this.waypointIndex] ?? null;
  }
}

/**
 * Waypoints evenly spaced on a circle, rounded to the tile grid. Consecutive
 * duplicates (small radii round several angles onto the same tile) are dropped so
 * the patrol never "arrives" twice in a row on the same tile.
 */
function buildRing(center: Position, radius: number, points: number): Position[] {
  const ring: Position[] = [];

  for (let i = 0; i < points; i += 1) {
    const angle = (2 * Math.PI * i) / points;
    const candidate = new Position(
      center.X + Math.round(radius * Math.cos(angle)),
      center.Y + Math.round(radius * Math.sin(angle)),
    );

    const previous = ring[ring.length - 1];
    if (previous === undefined || !samePosition(previous, candidate)) {
      ring.push(candidate);
    }
  }

  // The first and last tile can also collide after rounding.
  if (ring.length > 1 && samePosition(ring[0], ring[ring.length - 1])) {
    ring.pop();
  }

  return ring.length > 0 ? ring : [center];
}

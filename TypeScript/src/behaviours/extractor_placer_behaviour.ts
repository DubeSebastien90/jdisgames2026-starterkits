import * as MessageProtocol from "../client/message_protocol";
import { IBehaviour } from "./ibehaviour";

type Phase = "seek" | "walk" | "place" | "done";

/**
 * Walk to the nearest sugar cane node that can host an extractor (and doesn't
 * already have one), then place an extractor on it. Repeats for every eligible
 * node in sight.
 */
export class ExtractorPlacerBehaviour implements IBehaviour {
  public readonly name = "extractor-placer";

  private tag = "bot";
  private phase: Phase = "seek";
  private targetId: number | null = null;
  private targetPosition: MessageProtocol.Position | null = null;
  /** Node IDs we already placed an extractor on (or that already had one). */
  private readonly handled = new Set<number>();
  private posBeforeMove: MessageProtocol.Position | null = null;
  private lastMoveTarget: MessageProtocol.Position | null = null;
  private stuckTicks = 0;
  private static readonly STUCK_LIMIT = 15;

  public getNextAction(
    state: MessageProtocol.GameState,
  ): MessageProtocol.ActionBase | null {
    if (!state.Bot) {
      return null;
    }

    this.tag = state.Bot.BotType || "bot";
    const pos = state.Bot.Position;

    // Mark nodes that already have an allied extractor so we don't target them.
    this.markExistingExtractors(state);

    // Detect if we got stuck walking.
    this.detectStuck(pos);

    if (this.phase === "seek" || this.phase === "done") {
      return this.seek(state, pos);
    }
    if (this.phase === "walk") {
      return this.walk(state, pos);
    }
    // phase === "place"
    return this.place(state, pos);
  }

  private seek(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    const node = this.findBestNode(state, pos);
    if (!node) {
      if (this.phase !== "done") {
        console.log(`[${this.tag}] No sugar cane node available for an extractor.`);
        this.phase = "done";
      }
      return null;
    }

    this.targetId = node.Id;
    this.targetPosition = node.Position;
    this.phase = "walk";
    this.stuckTicks = 0;
    console.log(
      `[${this.tag}] Targeting ${node.Name} at ${node.Position.X},${node.Position.Y} for extractor.`,
    );
    return this.walk(state, pos);
  }

  private walk(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    if (!this.targetPosition) {
      this.phase = "seek";
      return this.seek(state, pos);
    }

    // If stuck too long, skip this node and try another.
    if (this.stuckTicks > ExtractorPlacerBehaviour.STUCK_LIMIT) {
      console.log(`[${this.tag}] Stuck trying to reach node ${this.targetId}, skipping.`);
      if (this.targetId !== null) {
        this.handled.add(this.targetId);
      }
      this.phase = "seek";
      return this.seek(state, pos);
    }

    const distance = this.chebyshev(pos, this.targetPosition);
    if (distance <= 1) {
      this.phase = "place";
      return this.place(state, pos);
    }

    return this.stepToward(pos, this.targetPosition);
  }

  private place(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    if (!this.targetPosition || this.targetId === null) {
      this.phase = "seek";
      return this.seek(state, pos);
    }

    console.log(
      `[${this.tag}] Placing extractor on node ${this.targetId} at ${this.targetPosition.X},${this.targetPosition.Y}.`,
    );

    const action = new MessageProtocol.PlaceExtractorAction(this.targetPosition);
    this.handled.add(this.targetId);
    this.targetId = null;
    this.targetPosition = null;
    this.phase = "seek";
    return action;
  }

  /**
   * Mark any node that already has an allied extractor on it so we skip it.
   */
  private markExistingExtractors(state: MessageProtocol.GameState): void {
    for (const structure of state.VisibleStructures) {
      if (structure.Type === "Extractor" && structure.IsAlly) {
        // Find the resource at that position and mark it handled.
        for (const resource of state.VisibleResources) {
          if (
            resource.Position.X === structure.Position.X &&
            resource.Position.Y === structure.Position.Y
          ) {
            this.handled.add(resource.Id);
          }
        }
      }
    }
  }

  /**
   * Find the nearest sugar cane node that supports an extractor and hasn't
   * been handled yet.
   */
  private findBestNode(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.Resource | null {
    let best: MessageProtocol.Resource | null = null;
    let bestDist = Number.POSITIVE_INFINITY;

    for (const resource of state.VisibleResources) {
      if (this.handled.has(resource.Id)) {
        continue;
      }
      if (!resource.CanHostExtractor) {
        continue;
      }

      const dist = this.manhattan(pos, resource.Position);
      if (dist < bestDist) {
        bestDist = dist;
        best = resource;
      }
    }

    return best;
  }

  private detectStuck(pos: MessageProtocol.Position): void {
    const from = this.posBeforeMove;
    if (from && pos.X === from.X && pos.Y === from.Y) {
      this.stuckTicks++;
    } else {
      this.stuckTicks = 0;
    }
    this.posBeforeMove = null;
    this.lastMoveTarget = null;
  }

  private stepToward(
    from: MessageProtocol.Position,
    to: MessageProtocol.Position,
  ): MessageProtocol.MoveAction {
    this.posBeforeMove = from;
    const dx = to.X - from.X;
    const dy = to.Y - from.Y;
    const next =
      Math.abs(dx) >= Math.abs(dy)
        ? new MessageProtocol.Position(from.X + Math.sign(dx), from.Y)
        : new MessageProtocol.Position(from.X, from.Y + Math.sign(dy));
    this.lastMoveTarget = next;
    return new MessageProtocol.MoveAction(next);
  }

  private manhattan(a: MessageProtocol.Position, b: MessageProtocol.Position): number {
    return Math.abs(a.X - b.X) + Math.abs(a.Y - b.Y);
  }

  private chebyshev(a: MessageProtocol.Position, b: MessageProtocol.Position): number {
    return Math.max(Math.abs(a.X - b.X), Math.abs(a.Y - b.Y));
  }
}

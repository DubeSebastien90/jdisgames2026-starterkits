import * as MessageProtocol from "../client/message_protocol";
import { IBehaviour } from "./ibehaviour";

type Phase = "seek" | "walk" | "place" | "explore";

const LIQUID_NAMES = ["corn syrup", "maple syrup", "vanilla", "soda"];

/**
 * Walk to the nearest liquid resource node that can host a pump (and doesn't
 * already have one), then place a pump on it. When no eligible node is in
 * sight, pick a cardinal direction and explore until one appears.
 */
export class PumpPlacerBehaviour implements IBehaviour {
  public readonly name = "pump-placer";

  private tag = "bot";
  private phase: Phase = "seek";
  private targetId: number | null = null;
  private targetPosition: MessageProtocol.Position | null = null;
  private readonly handled = new Set<number>();
  private posBeforeMove: MessageProtocol.Position | null = null;
  private lastMoveTarget: MessageProtocol.Position | null = null;
  private stuckTicks = 0;
  private static readonly STUCK_LIMIT = 15;

  private static readonly EXPLORE_LEG = 20;
  private static readonly DIRECTIONS: { x: number; y: number }[] = [
    { x: 0, y: -1 }, // north
    { x: 1, y: 0 },  // east
    { x: 0, y: 1 },  // south
    { x: -1, y: 0 }, // west
  ];
  private exploreIndex = 0;
  private exploreTicksLeft = 0;

  public getNextAction(
    state: MessageProtocol.GameState,
  ): MessageProtocol.ActionBase | null {
    if (!state.Bot) {
      return null;
    }

    this.tag = state.Bot.BotType || "bot";
    const pos = state.Bot.Position;

    this.markExistingPumps(state);
    this.detectStuck(pos);

    if (this.phase === "seek" || this.phase === "explore") {
      return this.seek(state, pos);
    }
    if (this.phase === "walk") {
      return this.walk(state, pos);
    }
    return this.place(state, pos);
  }

  private seek(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    // DEBUG: log all visible resource names so we can see what the server sends.
    if (state.VisibleResources.length > 0 && state.CurrentTick % 20 === 0) {
      const names = state.VisibleResources.map(
        (r) => `"${r.Name}" pump=${r.CanHostPump} handled=${this.handled.has(r.Id)}`,
      );
      console.log(`[${this.tag}] Visible resources: ${names.join(" | ")}`);
    }

    const node = this.findBestNode(state, pos);
    if (!node) {
      return this.explore(pos);
    }

    this.targetId = node.Id;
    this.targetPosition = node.Position;
    this.phase = "walk";
    this.stuckTicks = 0;
    console.log(
      `[${this.tag}] Targeting ${node.Name} at ${node.Position.X},${node.Position.Y} for pump.`,
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

    if (this.stuckTicks > PumpPlacerBehaviour.STUCK_LIMIT) {
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
      `[${this.tag}] Placing pump on node ${this.targetId} at ${this.targetPosition.X},${this.targetPosition.Y}.`,
    );

    const action = new MessageProtocol.PlacePumpAction(this.targetPosition);
    this.handled.add(this.targetId);
    this.targetId = null;
    this.targetPosition = null;
    this.phase = "seek";
    return action;
  }

  private markExistingPumps(state: MessageProtocol.GameState): void {
    for (const structure of state.VisibleStructures) {
      if (structure.Type === "Pump" && structure.IsAlly) {
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

  private explore(pos: MessageProtocol.Position): MessageProtocol.MoveAction {
    if (this.phase !== "explore" || this.exploreTicksLeft <= 0 || this.stuckTicks > PumpPlacerBehaviour.STUCK_LIMIT) {
      if (this.phase === "explore" && this.stuckTicks > PumpPlacerBehaviour.STUCK_LIMIT) {
        // Blocked in this direction, try the next one.
        this.exploreIndex = (this.exploreIndex + 1) % PumpPlacerBehaviour.DIRECTIONS.length;
      }
      const dir = PumpPlacerBehaviour.DIRECTIONS[this.exploreIndex];
      const labels = ["north", "east", "south", "west"];
      console.log(`[${this.tag}] No liquid node in sight, exploring ${labels[this.exploreIndex]}.`);
      this.phase = "explore";
      this.exploreTicksLeft = PumpPlacerBehaviour.EXPLORE_LEG;
      this.stuckTicks = 0;
    }

    this.exploreTicksLeft--;
    if (this.exploreTicksLeft <= 0) {
      this.exploreIndex = (this.exploreIndex + 1) % PumpPlacerBehaviour.DIRECTIONS.length;
    }

    const dir = PumpPlacerBehaviour.DIRECTIONS[this.exploreIndex];
    return this.stepToward(
      pos,
      new MessageProtocol.Position(pos.X + dir.x * 10, pos.Y + dir.y * 10),
    );
  }

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
      if (!resource.CanHostPump) {
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

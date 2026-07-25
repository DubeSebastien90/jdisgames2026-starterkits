import * as MessageProtocol from "../client/message_protocol";
import { IBehaviour } from "./ibehaviour";
import {
  ResourceKind,
  matchesResourceKind,
  resourceKindLabel,
} from "../world/resource_kinds";

type Phase = "seek" | "walk" | "place" | "wait" | "explore";

/** Knobs a caller may want to change without subclassing. */
export interface StructureOnResourceOptions {
  /**
   * Also target nodes that currently refuse the structure (CanHostExtractor /
   * CanHostPump false) but are only locked by their regen cooldown: stand next
   * to them and retry until the timer runs out. On by default — a picky bot
   * that skipped every node on cooldown would walk past the one node it wants.
   *
   * Ready nodes are always preferred; a locked one is only chosen when nothing
   * of the right kind is available.
   */
  includeLocked?: boolean;
}

/**
 * Walk to the nearest node of a *named* kind and drop a structure on it, then
 * do the same for the next one. When nothing eligible is in sight it explores in
 * cardinal legs until something shows up, because asking for one kind of node
 * means it will often not be on screen at spawn.
 *
 * The subclass says which structure it places and which nodes can host it; the
 * seek/walk/place loop lives here so the extractor and pump versions cannot
 * drift apart. See ExtractorPlacerOnResourceBehaviour /
 * PumpPlacerOnResourceBehaviour.
 */
export abstract class StructureOnResourceBehaviour implements IBehaviour {
  /** Structure.Type as the server reports it, e.g. "Extractor" or "Pump". */
  protected abstract readonly structureType: string;

  /** Can this node host our structure right now (CanHostExtractor / CanHostPump)? */
  protected abstract canHost(resource: MessageProtocol.Resource): boolean;

  /** The action that actually places it. */
  protected abstract placeAction(
    position: MessageProtocol.Position,
  ): MessageProtocol.ActionBase;

  public readonly name: string;

  /** The kinds of node we accept. Everything else is ignored. */
  protected readonly kinds: readonly ResourceKind[];
  protected readonly includeLocked: boolean;

  private tag = "bot";
  private phase: Phase = "seek";
  private targetId: number | null = null;
  private targetPosition: MessageProtocol.Position | null = null;
  /** Node ids we already placed on (or that already had one). */
  private readonly handled = new Set<number>();
  /** Locked nodes we ran out of patience for, and the tick they come back. */
  private readonly ignoredUntil = new Map<number, number>();
  private posBeforeMove: MessageProtocol.Position | null = null;
  private stuckTicks = 0;
  private static readonly STUCK_LIMIT = 15;

  // Ticks to stand beside a locked node before writing this one off and looking
  // for another. The node's own RemainingTicks decides when it says something;
  // these are the floor and the ceiling around it. Respawns run 180s (cotton
  // candy) to 720s (soda) in the docs, so waiting is long on purpose: walking
  // away and back costs more than waiting it out.
  private static readonly LOCKED_PATIENCE_MIN = 250;
  private static readonly LOCKED_PATIENCE_MAX = 800;
  // Ticks of slack on top of a timer the node gave us, since it ticks down as
  // we watch and the structure only becomes placeable once it hits zero.
  private static readonly LOCKED_PATIENCE_MARGIN = 15;
  // While waiting, try placing anyway this often. The flag is what we go on, but
  // a refused action costs exactly one tick — the same as standing idle — so an
  // occasional probe is free insurance against a flag that lags the cooldown.
  private static readonly LOCKED_RETRY_EVERY = 5;
  // How long a node we gave up waiting on stays skipped.
  private static readonly LOCKED_IGNORE_TTL = 400;
  // Ticks between "still on cooldown" reports, so waiting is not spammy.
  private static readonly WAIT_LOG_EVERY = 25;

  private static readonly EXPLORE_LEG = 20;
  private static readonly DIRECTIONS: { x: number; y: number; label: string }[] = [
    { x: 0, y: -1, label: "north" },
    { x: 1, y: 0, label: "east" },
    { x: 0, y: 1, label: "south" },
    { x: -1, y: 0, label: "west" },
  ];
  private exploreIndex = 0;
  private exploreTicksLeft = 0;

  private waitingSince: number | null = null;
  private lastProbeTick = 0;
  private lastWaitLogTick = 0;

  protected constructor(
    label: string,
    kinds: ResourceKind | readonly ResourceKind[],
    options: StructureOnResourceOptions = {},
  ) {
    this.kinds = Array.isArray(kinds) ? [...kinds] : [kinds as ResourceKind];
    this.includeLocked = options.includeLocked ?? true;
    this.name = `${label}:${this.kinds.join("+")}`;
  }

  public getNextAction(
    state: MessageProtocol.GameState,
  ): MessageProtocol.ActionBase | null {
    if (!state.Bot) {
      return null;
    }

    this.tag = state.Bot.BotType || "bot";
    const pos = state.Bot.Position;

    this.markExistingStructures(state);
    this.detectStuck(pos);

    if (this.phase === "seek" || this.phase === "explore") {
      return this.seek(state, pos);
    }
    if (this.phase === "walk") {
      return this.walk(state, pos);
    }
    if (this.phase === "wait") {
      return this.wait(state, pos);
    }
    return this.place(state, pos);
  }

  private seek(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    const node = this.findBestNode(state, pos);
    if (!node) {
      return this.explore(pos);
    }

    this.targetId = node.Id;
    this.targetPosition = node.Position;
    this.phase = "walk";
    this.stuckTicks = 0;
    this.waitingSince = null;
    const locked = this.canHost(node)
      ? ""
      : ` (locked, ${node.RemainingTicks} ticks of cooldown left)`;
    console.log(
      `[${this.tag}] Targeting ${node.Name} at ${node.Position.X},${node.Position.Y} ` +
        `for a ${this.structureType.toLowerCase()}${locked}.`,
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

    // If stuck too long, give up on this node and look for another.
    if (this.stuckTicks > StructureOnResourceBehaviour.STUCK_LIMIT) {
      console.log(`[${this.tag}] Stuck trying to reach node ${this.targetId}, skipping.`);
      if (this.targetId !== null) {
        this.handled.add(this.targetId);
      }
      this.phase = "seek";
      return this.seek(state, pos);
    }

    // Adjacent is close enough to place.
    if (this.chebyshev(pos, this.targetPosition) <= 1) {
      const node = this.visibleTarget(state);
      if (node && !this.canHost(node)) {
        // Still on cooldown: hold the spot rather than hand it to someone else.
        this.phase = "wait";
        return this.wait(state, pos);
      }
      this.phase = "place";
      return this.place(state, pos);
    }

    return this.stepToward(pos, this.targetPosition);
  }

  /**
   * Standing next to a node that is locked by its cooldown. Wait it out, probing
   * now and then in case the flag is more conservative than the server, and move
   * on once patience runs out.
   */
  private wait(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    if (this.targetId === null || !this.targetPosition) {
      this.phase = "seek";
      return this.seek(state, pos);
    }

    // A probe worked: markExistingStructures saw our structure appear on it.
    if (this.handled.has(this.targetId)) {
      console.log(`[${this.tag}] Node ${this.targetId} took the ${this.structureType.toLowerCase()}.`);
      return this.finishTarget(state, pos);
    }

    const node = this.visibleTarget(state);
    if (!node || this.canHost(node)) {
      // Cooldown is over (or we lost sight of it) — just place.
      this.phase = "place";
      return this.place(state, pos);
    }

    if (this.waitingSince === null) {
      this.waitingSince = state.CurrentTick;
      this.lastProbeTick = state.CurrentTick;
      this.lastWaitLogTick = state.CurrentTick;
      console.log(
        `[${this.tag}] ${node.Name} at ${node.Position.X},${node.Position.Y} is locked ` +
          `(${node.RemainingTicks} ticks left), waiting beside it.`,
      );
    }

    const waited = state.CurrentTick - this.waitingSince;
    if (waited > this.patienceFor(node)) {
      console.log(
        `[${this.tag}] Waited ${waited} ticks on node ${this.targetId}, giving up on it for now.`,
      );
      this.ignoredUntil.set(
        this.targetId,
        state.CurrentTick + StructureOnResourceBehaviour.LOCKED_IGNORE_TTL,
      );
      return this.finishTarget(state, pos);
    }

    if (
      state.CurrentTick - this.lastWaitLogTick >=
      StructureOnResourceBehaviour.WAIT_LOG_EVERY
    ) {
      this.lastWaitLogTick = state.CurrentTick;
      console.log(
        `[${this.tag}] Still waiting on node ${this.targetId}, ${node.RemainingTicks} ticks of cooldown left.`,
      );
    }

    if (
      state.CurrentTick - this.lastProbeTick >=
      StructureOnResourceBehaviour.LOCKED_RETRY_EVERY
    ) {
      this.lastProbeTick = state.CurrentTick;
      // Probe only: if it lands, the structure shows up next tick and the check
      // at the top of wait() picks it up. Nothing is marked handled on a guess.
      return this.placeAction(this.targetPosition);
    }

    return null;
  }

  /**
   * How long to hold the spot. The node's own countdown when it gives us one,
   * clamped: a timer of 600 is worth waiting out, a timer the server never
   * filled in is not worth standing there forever for.
   */
  private patienceFor(node: MessageProtocol.Resource): number {
    const claimed = node.RemainingTicks + StructureOnResourceBehaviour.LOCKED_PATIENCE_MARGIN;
    return Math.min(
      StructureOnResourceBehaviour.LOCKED_PATIENCE_MAX,
      Math.max(StructureOnResourceBehaviour.LOCKED_PATIENCE_MIN, claimed),
    );
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
      `[${this.tag}] Placing ${this.structureType.toLowerCase()} on node ` +
        `${this.targetId} at ${this.targetPosition.X},${this.targetPosition.Y}.`,
    );

    const action = this.placeAction(this.targetPosition);
    this.handled.add(this.targetId);
    this.clearTarget();
    this.phase = "seek";
    return action;
  }

  /** Drop the current target and go find the next one this same tick. */
  private finishTarget(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    this.clearTarget();
    this.phase = "seek";
    return this.seek(state, pos);
  }

  private clearTarget(): void {
    this.targetId = null;
    this.targetPosition = null;
    this.waitingSince = null;
  }

  private visibleTarget(
    state: MessageProtocol.GameState,
  ): MessageProtocol.Resource | null {
    if (this.targetId === null) {
      return null;
    }
    return state.VisibleResources.find((r) => r.Id === this.targetId) ?? null;
  }

  /** Skip any node that already carries one of ours. */
  private markExistingStructures(state: MessageProtocol.GameState): void {
    for (const structure of state.VisibleStructures) {
      if (structure.Type !== this.structureType || !structure.IsAlly) {
        continue;
      }
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

  /**
   * A node is on cooldown when its regen timer is running or it is empty. That
   * is the one reason we are willing to walk to a node that says it cannot host
   * us: anything else refusing means this node is simply not for us.
   */
  private isOnCooldown(resource: MessageProtocol.Resource): boolean {
    return resource.RemainingTicks > 0 || resource.CurrentAmount <= 0;
  }

  /**
   * Nearest node of the right kind. Ready nodes win; a locked-but-regenerating
   * one is only picked when there is no ready node of that kind in sight.
   */
  private findBestNode(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.Resource | null {
    let ready: MessageProtocol.Resource | null = null;
    let readyDist = Number.POSITIVE_INFINITY;
    let locked: MessageProtocol.Resource | null = null;
    let lockedDist = Number.POSITIVE_INFINITY;

    for (const resource of state.VisibleResources) {
      if (this.handled.has(resource.Id)) {
        continue;
      }
      if (!matchesResourceKind(resource, this.kinds)) {
        continue;
      }

      const dist = this.manhattan(pos, resource.Position);

      if (this.canHost(resource)) {
        if (dist < readyDist) {
          readyDist = dist;
          ready = resource;
        }
        continue;
      }

      if (!this.includeLocked || !this.isOnCooldown(resource)) {
        continue;
      }
      const ignoredUntil = this.ignoredUntil.get(resource.Id);
      if (ignoredUntil !== undefined && state.CurrentTick < ignoredUntil) {
        continue;
      }
      if (dist < lockedDist) {
        lockedDist = dist;
        locked = resource;
      }
    }

    return ready ?? locked;
  }

  private explore(pos: MessageProtocol.Position): MessageProtocol.MoveAction {
    const blocked = this.stuckTicks > StructureOnResourceBehaviour.STUCK_LIMIT;

    if (this.phase !== "explore" || this.exploreTicksLeft <= 0 || blocked) {
      if (this.phase === "explore" && blocked) {
        // Walled in this way, try the next direction.
        this.exploreIndex =
          (this.exploreIndex + 1) % StructureOnResourceBehaviour.DIRECTIONS.length;
      }
      const wanted = this.kinds.map(resourceKindLabel).join(" or ");
      console.log(
        `[${this.tag}] No ${wanted} node in sight, exploring ` +
          `${StructureOnResourceBehaviour.DIRECTIONS[this.exploreIndex].label}.`,
      );
      this.phase = "explore";
      this.exploreTicksLeft = StructureOnResourceBehaviour.EXPLORE_LEG;
      this.stuckTicks = 0;
    }

    this.exploreTicksLeft--;
    if (this.exploreTicksLeft <= 0) {
      this.exploreIndex =
        (this.exploreIndex + 1) % StructureOnResourceBehaviour.DIRECTIONS.length;
    }

    const dir = StructureOnResourceBehaviour.DIRECTIONS[this.exploreIndex];
    return this.stepToward(
      pos,
      new MessageProtocol.Position(pos.X + dir.x * 10, pos.Y + dir.y * 10),
    );
  }

  private detectStuck(pos: MessageProtocol.Position): void {
    const from = this.posBeforeMove;
    if (from && pos.X === from.X && pos.Y === from.Y) {
      this.stuckTicks++;
    } else {
      this.stuckTicks = 0;
    }
    this.posBeforeMove = null;
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
    return new MessageProtocol.MoveAction(next);
  }

  private manhattan(a: MessageProtocol.Position, b: MessageProtocol.Position): number {
    return Math.abs(a.X - b.X) + Math.abs(a.Y - b.Y);
  }

  private chebyshev(a: MessageProtocol.Position, b: MessageProtocol.Position): number {
    return Math.max(Math.abs(a.X - b.X), Math.abs(a.Y - b.Y));
  }
}

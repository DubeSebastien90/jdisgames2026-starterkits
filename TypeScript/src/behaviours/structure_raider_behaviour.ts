import * as MessageProtocol from "../client/message_protocol";
import { IBehaviour } from "./ibehaviour";
import {
  ResourceKind,
  matchesResourceKind,
  resourceKindLabel,
} from "../world/resource_kinds";

type Phase = "hunt" | "approach" | "attack" | "explore";

export interface StructureRaiderOptions {
  /**
   * Only hit structures standing on one of these resource kinds, e.g.
   * "maple_syrup" to take out the enemy's syrup pumps and nothing else. Omit to
   * hit any structure of the right type.
   */
  onResource?: ResourceKind | readonly ResourceKind[];
  /**
   * Structure types worth a swing. The server spells them "Pump", "Extractor",
   * "Radar". Bases cannot be destroyed, so they are never a target.
   */
  structureTypes?: readonly string[];
  /**
   * Skip targets whose PvpActivated flag is false. On by default: PVP has to be
   * on for *both* teams, and swinging at a structure that cannot be damaged just
   * burns the match standing in enemy territory.
   */
  requirePvp?: boolean;
}

/**
 * Attack mode. Walk to an enemy structure and hit it until it is gone, then find
 * the next one.
 *
 * Two things the docs are firm about (see /pvp): PVP is opt-in by both teams and
 * cannot be switched off once on, and nothing inside an enemy's base safezone
 * can be destroyed. Neither is something a bot can change — this behaviour only
 * decides where to swing, so if PVP is off it will find targets, hit them, and
 * watch their HP never move. That is what the giving-up rule below is for.
 */
export class StructureRaiderBehaviour implements IBehaviour {
  public readonly name: string;

  // Docs do not state attack range, so assume you have to be next to it. If it
  // turns out to reach further, raise this and the bot stops closing the gap.
  private static readonly ATTACK_RANGE = 1;
  // Swings landing on a target whose HP never moves before we write it off. It
  // is in a safezone, or PVP is not on for both teams — either way, hitting it
  // is a wasted match.
  private static readonly FUTILE_SWINGS = 12;
  // How long a target we gave up on stays skipped.
  private static readonly IGNORE_TTL = 600;
  private static readonly STUCK_LIMIT = 15;
  private static readonly EXPLORE_LEG = 20;
  private static readonly DIRECTIONS: { x: number; y: number; label: string }[] = [
    { x: 0, y: -1, label: "north" },
    { x: 1, y: 0, label: "east" },
    { x: 0, y: 1, label: "south" },
    { x: -1, y: 0, label: "west" },
  ];

  private readonly kinds: readonly ResourceKind[] | null;
  private readonly structureTypes: readonly string[];
  private readonly requirePvp: boolean;

  private tag = "bot";
  private phase: Phase = "hunt";
  private targetId: number | null = null;
  private targetPosition: MessageProtocol.Position | null = null;
  private lastTargetHp: number | null = null;
  private futileSwings = 0;
  private readonly ignoredUntil = new Map<number, number>();
  /**
   * Which resource kind sits under a tile, remembered from when we could see it.
   * An enemy structure standing on a node can hide it from VisibleResources, and
   * a raider that forgets what the node was cannot tell a syrup pump from any
   * other. Terrain does not move, so this never goes stale.
   */
  private readonly nodeMatchAt = new Map<string, boolean>();
  private posBeforeMove: MessageProtocol.Position | null = null;
  private stuckTicks = 0;
  private exploreIndex = 0;
  private exploreTicksLeft = 0;

  public constructor(options: StructureRaiderOptions = {}) {
    const onResource = options.onResource;
    this.kinds =
      onResource === undefined
        ? null
        : Array.isArray(onResource)
          ? [...onResource]
          : [onResource as ResourceKind];
    this.structureTypes = options.structureTypes ?? ["Pump", "Extractor", "Radar"];
    this.requirePvp = options.requirePvp ?? true;

    const what = this.kinds ? this.kinds.join("+") : "any";
    this.name = `raider:${this.structureTypes.join("/")}@${what}`;
  }

  public getNextAction(
    state: MessageProtocol.GameState,
  ): MessageProtocol.ActionBase | null {
    if (!state.Bot) {
      return null;
    }

    this.tag = state.Bot.BotType || "bot";
    const pos = state.Bot.Position;

    this.rememberNodes(state);
    this.detectStuck(pos);

    if (this.phase === "hunt" || this.phase === "explore") {
      return this.hunt(state, pos);
    }
    if (this.phase === "approach") {
      return this.approach(state, pos);
    }
    return this.attack(state, pos);
  }

  private hunt(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    const target = this.findTarget(state, pos);
    if (!target) {
      return this.explore(pos);
    }

    this.targetId = target.Id;
    this.targetPosition = target.Position;
    this.lastTargetHp = null;
    this.futileSwings = 0;
    this.stuckTicks = 0;
    this.phase = "approach";
    console.log(
      `[${this.tag}] Raiding enemy ${target.Type} at ${target.Position.X},${target.Position.Y} ` +
        `(${target.Hp}/${target.MaxHp} hp, team ${target.OwnerTeamId}).`,
    );
    return this.approach(state, pos);
  }

  private approach(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    if (!this.targetPosition) {
      return this.dropTarget(state, pos);
    }

    if (this.stuckTicks > StructureRaiderBehaviour.STUCK_LIMIT) {
      console.log(`[${this.tag}] Cannot reach the ${this.targetLabel()}, looking elsewhere.`);
      return this.giveUpOnTarget(state, pos);
    }

    if (
      this.chebyshev(pos, this.targetPosition) <= StructureRaiderBehaviour.ATTACK_RANGE
    ) {
      this.phase = "attack";
      return this.attack(state, pos);
    }

    return this.stepToward(pos, this.targetPosition);
  }

  private attack(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    if (this.targetId === null || !this.targetPosition) {
      return this.dropTarget(state, pos);
    }

    const target = this.visibleTarget(state);

    // Gone from a tile we are standing next to means we levelled it.
    if (!target) {
      if (this.chebyshev(pos, this.targetPosition) <= StructureRaiderBehaviour.ATTACK_RANGE) {
        console.log(`[${this.tag}] Destroyed the ${this.targetLabel()}.`);
        return this.dropTarget(state, pos);
      }
      // Lost sight of it instead — walk back and have another look.
      this.phase = "approach";
      return this.approach(state, pos);
    }

    if (this.chebyshev(pos, this.targetPosition) > StructureRaiderBehaviour.ATTACK_RANGE) {
      this.phase = "approach";
      return this.approach(state, pos);
    }

    // Is the damage landing? HP that never moves means it cannot be hurt.
    if (this.lastTargetHp !== null && target.Hp >= this.lastTargetHp) {
      this.futileSwings++;
      if (this.futileSwings >= StructureRaiderBehaviour.FUTILE_SWINGS) {
        console.log(
          `[${this.tag}] ${this.futileSwings} swings and the ${this.targetLabel()} is still ` +
            `${target.Hp}/${target.MaxHp} — safezone, or PVP is not on for both teams. Moving on.`,
        );
        return this.giveUpOnTarget(state, pos);
      }
    } else {
      this.futileSwings = 0;
      if (this.lastTargetHp !== null) {
        console.log(
          `[${this.tag}] ${this.targetLabel()} down to ${target.Hp}/${target.MaxHp} hp.`,
        );
      }
    }

    this.lastTargetHp = target.Hp;
    return new MessageProtocol.AttackAction(this.targetPosition);
  }

  /**
   * Nearest enemy structure worth hitting. Filtered by type, by the PVP flag,
   * and — the point of the thing — by what it is standing on.
   */
  private findTarget(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.VisibleStructure | null {
    let best: MessageProtocol.VisibleStructure | null = null;
    let bestDist = Number.POSITIVE_INFINITY;

    for (const structure of state.VisibleStructures) {
      if (structure.IsAlly) {
        continue;
      }
      if (!this.structureTypes.includes(structure.Type)) {
        continue;
      }
      if (this.requirePvp && !structure.PvpActivated) {
        continue;
      }
      const ignoredUntil = this.ignoredUntil.get(structure.Id);
      if (ignoredUntil !== undefined && state.CurrentTick < ignoredUntil) {
        continue;
      }
      if (!this.standsOnWantedNode(structure.Position)) {
        continue;
      }

      const dist = this.manhattan(pos, structure.Position);
      if (dist < bestDist) {
        bestDist = dist;
        best = structure;
      }
    }

    return best;
  }

  /** No filter means anything goes; otherwise the tile has to be a known match. */
  private standsOnWantedNode(position: MessageProtocol.Position): boolean {
    if (!this.kinds) {
      return true;
    }
    return this.nodeMatchAt.get(`${position.X},${position.Y}`) === true;
  }

  /** Note what kind of node each visible tile holds, for when it gets covered. */
  private rememberNodes(state: MessageProtocol.GameState): void {
    if (!this.kinds) {
      return;
    }
    for (const resource of state.VisibleResources) {
      this.nodeMatchAt.set(
        `${resource.Position.X},${resource.Position.Y}`,
        matchesResourceKind(resource, this.kinds),
      );
    }
  }

  private visibleTarget(
    state: MessageProtocol.GameState,
  ): MessageProtocol.VisibleStructure | null {
    if (this.targetId === null) {
      return null;
    }
    return state.VisibleStructures.find((s) => s.Id === this.targetId) ?? null;
  }

  private targetLabel(): string {
    const where = this.targetPosition
      ? ` at ${this.targetPosition.X},${this.targetPosition.Y}`
      : "";
    return `${this.structureTypes.length === 1 ? this.structureTypes[0] : "structure"}${where}`;
  }

  private giveUpOnTarget(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    if (this.targetId !== null) {
      this.ignoredUntil.set(
        this.targetId,
        state.CurrentTick + StructureRaiderBehaviour.IGNORE_TTL,
      );
    }
    return this.dropTarget(state, pos);
  }

  private dropTarget(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    this.targetId = null;
    this.targetPosition = null;
    this.lastTargetHp = null;
    this.futileSwings = 0;
    this.phase = "hunt";
    return this.hunt(state, pos);
  }

  private explore(pos: MessageProtocol.Position): MessageProtocol.MoveAction {
    const blocked = this.stuckTicks > StructureRaiderBehaviour.STUCK_LIMIT;

    if (this.phase !== "explore" || this.exploreTicksLeft <= 0 || blocked) {
      if (this.phase === "explore" && blocked) {
        this.exploreIndex =
          (this.exploreIndex + 1) % StructureRaiderBehaviour.DIRECTIONS.length;
      }
      const wanted = this.kinds
        ? ` on ${this.kinds.map(resourceKindLabel).join(" or ")}`
        : "";
      console.log(
        `[${this.tag}] No enemy ${this.structureTypes.join("/")}${wanted} in sight, ` +
          `exploring ${StructureRaiderBehaviour.DIRECTIONS[this.exploreIndex].label}.`,
      );
      this.phase = "explore";
      this.exploreTicksLeft = StructureRaiderBehaviour.EXPLORE_LEG;
      this.stuckTicks = 0;
    }

    this.exploreTicksLeft--;
    if (this.exploreTicksLeft <= 0) {
      this.exploreIndex =
        (this.exploreIndex + 1) % StructureRaiderBehaviour.DIRECTIONS.length;
    }

    const dir = StructureRaiderBehaviour.DIRECTIONS[this.exploreIndex];
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

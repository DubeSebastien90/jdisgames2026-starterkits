import * as MessageProtocol from "../client/message_protocol";
import {
  CombatBehaviour,
  CombatOptions,
  CombatTarget,
  CombatTargetKind,
} from "./combat_behaviour";

export interface DestroyBuildingOptions extends CombatOptions {
  /**
   * Structure types worth a swing. The server spells them "Pump", "Extractor"
   * and "Radar", which is also the full list of what can be destroyed — bases
   * are not external structures, so they are never a target.
   */
  structureTypes?: readonly string[];
  /**
   * Hit the closest structure regardless of type by default. Set this to work
   * down the list in order instead, e.g. take out radars first to blind them.
   */
  priority?: readonly string[];
}

/**
 * Attack mode, buildings only. Walk to the nearest enemy extractor, pump or radar
 * and take it apart, then find the next one. Enemy bots are ignored, even one
 * standing next to us — use DestroyEverythingBehaviour to fight both.
 *
 * Hits with DestroyStructureAction, which the docs list as the action that
 * "damages or destroys an external structure: extractor, pump, or radar".
 * AttackAction is documented for bots and companions only, so it is not what goes
 * here — swinging AttackAction at a pump watches its HP sit still forever.
 */
export class DestroyBuildingBehaviour extends CombatBehaviour {
  public readonly name: string;

  private static readonly ALL_TYPES = ["Pump", "Extractor", "Radar"] as const;

  private readonly structureTypes: readonly string[];
  private readonly priority: readonly string[];

  public constructor(options: DestroyBuildingOptions = {}) {
    super(options);
    this.structureTypes =
      options.structureTypes ?? DestroyBuildingBehaviour.ALL_TYPES;
    this.priority = options.priority ?? [];
    this.name = `destroy-building:${this.structureTypes.join("/")}`;
  }

  protected quarry(): string {
    return `enemy ${this.structureTypes.join("/")}`;
  }

  /** Only walk back to machines, and only ones we would actually hit. */
  protected override wantsLead(kind: CombatTargetKind, type: string): boolean {
    return kind === "structure" && this.structureTypes.includes(type);
  }

  protected findTarget(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): CombatTarget | null {
    const candidates = this.structureTargets(state, this.structureTypes);

    if (this.priority.length === 0) {
      return this.nearest(pos, candidates);
    }

    let best: CombatTarget | null = null;
    let bestRank = Number.POSITIVE_INFINITY;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
      // Unlisted types sort after every listed one, so anything not named still
      // gets hit once the favoured types are gone.
      const rank = this.rankOf(candidate);
      const distance = this.travelDistance(pos, candidate);

      if (rank < bestRank || (rank === bestRank && distance < bestDistance)) {
        bestRank = rank;
        bestDistance = distance;
        best = candidate;
      }
    }

    return best;
  }

  /** Where this target's type sits in the priority list. */
  private rankOf(target: CombatTarget): number {
    const index = this.priority.indexOf(target.type);
    return index === -1 ? this.priority.length : index;
  }
}

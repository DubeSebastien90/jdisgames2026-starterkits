import * as MessageProtocol from "../client/message_protocol";
import { CombatBehaviour, CombatOptions, CombatTarget } from "./combat_behaviour";

export interface DestroyEverythingOptions extends CombatOptions {
  /**
   * Which pool wins when two targets are the same distance away. "closest" —
   * the default — means no preference at all: whatever is nearest gets hit,
   * whether that is a bot, a companion or a pump.
   *
   * "people" clears the defenders out before touching their machines; buildings
   * do not fight back, so a bot that starts on a pump can be worn down while it
   * swings. "buildings" is the opposite: hurt their economy and ignore the
   * duels.
   */
  prefer?: "closest" | "people" | "buildings";
  /**
   * Structure types worth a swing. The server spells them "Pump", "Extractor"
   * and "Radar", which is also the full list of what can be destroyed — bases
   * are not external structures, so they are never a target.
   */
  structureTypes?: readonly string[];
}

/**
 * Attack mode, no decisions required. Look at everything in sight — enemy bots,
 * their companions, their extractors, pumps and radars — walk to whichever is
 * closest, and take it apart. Then do it again.
 *
 * This is the one to put in the roster when you just want a bot fighting and do
 * not want to choose what it fights. DestroyBuildingBehaviour and
 * DestroyPeopleBehaviour are the same loop with one pool each, for when you do.
 *
 * The right action per target is picked automatically: DestroyStructureAction for
 * structures, AttackAction for anything alive, which is the split the docs draw.
 */
export class DestroyEverythingBehaviour extends CombatBehaviour {
  public readonly name: string;

  private static readonly ALL_TYPES = ["Pump", "Extractor", "Radar"] as const;
  /**
   * Tiles of detour a preference is worth. Ranking by pool first would walk
   * across the map past a bot standing next to us to reach a favoured pump, so a
   * preference only breaks ties and near-ties.
   */
  private static readonly PREFERENCE_WEIGHT = 8;

  private readonly prefer: "closest" | "people" | "buildings";
  private readonly structureTypes: readonly string[];

  public constructor(options: DestroyEverythingOptions = {}) {
    super(options);
    this.prefer = options.prefer ?? "closest";
    this.structureTypes =
      options.structureTypes ?? DestroyEverythingBehaviour.ALL_TYPES;
    this.name = `destroy-everything:${this.prefer}`;
  }

  protected quarry(): string {
    return "enemy bot, companion or structure";
  }

  protected findTarget(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): CombatTarget | null {
    const candidates = [
      ...this.playerTargets(state),
      ...this.companionTargets(state),
      ...this.structureTargets(state, this.structureTypes),
    ];

    if (this.prefer === "closest") {
      return this.nearest(pos, candidates);
    }

    let best: CombatTarget | null = null;
    let bestCost = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
      const isPerson = candidate.kind !== "structure";
      const favoured = this.prefer === "people" ? isPerson : !isPerson;
      const cost =
        this.travelDistance(pos, candidate) +
        (favoured ? 0 : DestroyEverythingBehaviour.PREFERENCE_WEIGHT);

      if (cost < bestCost) {
        bestCost = cost;
        best = candidate;
      }
    }

    return best;
  }
}

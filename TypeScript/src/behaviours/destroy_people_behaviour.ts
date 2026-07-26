import * as MessageProtocol from "../client/message_protocol";
import {
  CombatBehaviour,
  CombatOptions,
  CombatTarget,
  CombatTargetKind,
} from "./combat_behaviour";

export interface DestroyPeopleOptions extends CombatOptions {
  /**
   * Go after enemy companions as well as their bots. On by default: a companion
   * is walking home with someone else's loot, and it is the softer target of the
   * two. Set false to hunt bots only.
   */
  includeCompanions?: boolean;
  /**
   * How much a point of remaining health counts against a tile of distance when
   * picking between targets. 0 — the default — means always take the nearest;
   * higher numbers walk further for a weaker target. Health and shield count
   * together, since shield soaks damage first.
   */
  weakestBias?: number;
}

/**
 * Attack mode, people only. Walk to the nearest enemy bot or companion and hit it
 * until it stops being there, then find the next one. Enemy machines are ignored
 * — use DestroyEverythingBehaviour to fight both.
 *
 * Hits with AttackAction, which the docs describe as attacking "a bot or
 * companion at the target position", with PVP and safezone rules validated
 * server-side.
 *
 * The difference from raiding buildings is that people move. The target's
 * position is re-read every tick, and a target that leaves vision is chased to
 * where it was last seen rather than dropped straight away — the pathfinder
 * re-plans every tick anyway, so a moving target is just a moving goal.
 */
export class DestroyPeopleBehaviour extends CombatBehaviour {
  public readonly name: string;

  private readonly includeCompanions: boolean;
  private readonly weakestBias: number;

  public constructor(options: DestroyPeopleOptions = {}) {
    super(options);
    this.includeCompanions = options.includeCompanions ?? true;
    this.weakestBias = options.weakestBias ?? 0;
    this.name = this.includeCompanions
      ? "destroy-people:bots+companions"
      : "destroy-people:bots";
  }

  protected quarry(): string {
    return this.includeCompanions ? "enemy bot or companion" : "enemy bot";
  }

  /**
   * Never walk toward a remembered machine: we would arrive and refuse to hit it.
   * A remembered bot is a stale lead, but at least it is the right kind of thing.
   */
  protected override wantsLead(kind: CombatTargetKind): boolean {
    return kind !== "structure";
  }

  protected findTarget(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): CombatTarget | null {
    const candidates = this.includeCompanions
      ? [...this.playerTargets(state), ...this.companionTargets(state)]
      : this.playerTargets(state);

    if (this.weakestBias === 0) {
      return this.nearest(pos, candidates);
    }

    let best: CombatTarget | null = null;
    let bestCost = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
      // Distance is the base cost; weakestBias trades tiles walked for hp left.
      const cost =
        this.travelDistance(pos, candidate) + candidate.hp * this.weakestBias;
      if (cost < bestCost) {
        bestCost = cost;
        best = candidate;
      }
    }

    return best;
  }
}

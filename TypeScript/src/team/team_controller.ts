import { IBehaviour } from "../behaviours/ibehaviour";
import { GathererBehaviour } from "../behaviours/gatherer_behaviour";
import { CompanionFarmerBehaviour } from "../behaviours/companion_farmer_behaviour";
// import { ScoutBehaviour } from "../behaviours/scout_behaviour";

type BehaviourFactory = () => IBehaviour;

/**
 * Decides which behaviour each bot runs.
 *
 * ===================== EDIT THIS TO CHANGE THE TEAM =====================
 *
 * Keys are PlayerInfo.BotType as the server reports it, which matches the
 * token prefix: token BOTA-... reports "BotA".
 *
 * To give BotB a different job, write the behaviour in src/behaviours/ and
 * swap its line here, for example:
 *
 *   BotB: () => new ScoutBehaviour(),
 *
 * Each bot gets its own instance, so behaviours can hold per-bot state
 * without treading on each other.
 */
export class TeamController {
  private static readonly ROSTER: Record<string, BehaviourFactory> = {
    BotA: () => new GathererBehaviour(),
    BotB: () => new CompanionFarmerBehaviour(),
  };

  /** Used for any bot type not listed above. */
  private static readonly DEFAULT: BehaviourFactory = () => new GathererBehaviour();

  public static behaviourFor(botType: string): IBehaviour {
    const factory = TeamController.ROSTER[botType];
    if (factory) {
      return factory();
    }

    const fallback = TeamController.DEFAULT();
    console.log(
      `[TEAM] No behaviour registered for "${botType}", using ${fallback.name}. ` +
        "Add it to the ROSTER in src/team/team_controller.ts.",
    );
    return fallback;
  }
}

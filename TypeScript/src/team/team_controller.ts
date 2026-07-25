import { IBehaviour } from "../behaviours/ibehaviour";
import { GathererBehaviour } from "../behaviours/gatherer_behaviour";
import { CompanionFarmerBehaviour } from "../behaviours/companion_farmer_behaviour";
import { ExtractorPlacerBehaviour } from "../behaviours/extractor_placer_behaviour";
import { PumpPlacerBehaviour } from "../behaviours/pump_placer_behaviour";
import { ReturnToBaseBehaviour } from "../behaviours/return_to_base_behaviour";
import { GoLeftBehaviour } from "../behaviours/go_left_behaviour";
import { GoUpBehaviour } from "../behaviours/go_up_behaviour";
// import { ScoutBehaviour } from "../behaviours/scout_behaviour";
// Straight-line probes, for looking at what is in one direction:
// import { GoLeftBehaviour } from "../behaviours/go_left_behaviour";
// import { GoRightBehaviour } from "../behaviours/go_right_behaviour";
// import { GoUpBehaviour } from "../behaviours/go_up_behaviour";
// import { GoDownBehaviour } from "../behaviours/go_down_behaviour";

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
    BotA: () => new CompanionFarmerBehaviour(),
    BotB: () => new GathererBehaviour(),
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

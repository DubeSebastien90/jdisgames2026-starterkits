import { IBehaviour } from "../behaviours/ibehaviour";
import { GathererBehaviour } from "../behaviours/gatherer_behaviour";
import { CompanionFarmerBehaviour } from "../behaviours/companion_farmer_behaviour";
import { ExtractorPlacerBehaviour } from "../behaviours/extractor_placer_behaviour";
import { PumpPlacerBehaviour } from "../behaviours/pump_placer_behaviour";
import { ReturnToBaseBehaviour } from "../behaviours/return_to_base_behaviour";
import { PlaceRadarBehaviour } from "../behaviours/place_radar_behaviour";
import { GoUpBehaviour } from "../behaviours/go_up_behaviour";
import { GoRightBehaviour } from "../behaviours/go_right_behaviour";
import { GoDownBehaviour } from "../behaviours/go_down_behaviour";
import { GoLeftBehaviour } from "../behaviours/go_left_behaviour";
import { GameState, PlacePumpAction } from "../client/message_protocol";
// import { ScoutBehaviour } from "../behaviours/scout_behaviour";
// Picky placers: same job as the two above, but only on the kind you name.
import { ExtractorPlacerOnResourceBehaviour } from "../behaviours/extractor_placer_on_resource_behaviour";
import { PumpPlacerOnResourceBehaviour } from "../behaviours/pump_placer_on_resource_behaviour";
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
 *
 * The picky placers take the resource kind as an argument, so the strategy is
 * written here rather than baked into the behaviour:
 *
 *   BotA: () => new ExtractorPlacerOnResourceBehaviour("sugar_cane"),
 *   BotA: () => new ExtractorPlacerOnResourceBehaviour(["sugar_cane", "licorice"]),
 *   BotB: () => new PumpPlacerOnResourceBehaviour("maple_syrup"),
 *   BotB: () => new PumpPlacerOnResourceBehaviour(LIQUID_RESOURCE_KINDS),
 *
 * The names come from ResourceKind in src/world/resource_kinds.ts, so a typo is
 * a compile error. Both wait beside a node that is locked by its cooldown; pass
 * { includeLocked: false } as a second argument to skip those instead.
 */
export class TeamController {
  private static readonly ROSTER: Record<string, BehaviourFactory> = {
    BotA: () => new ExtractorPlacerOnResourceBehaviour("sugar_cane"),
    BotB: () => new PumpPlacerOnResourceBehaviour("maple_syrup"),
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

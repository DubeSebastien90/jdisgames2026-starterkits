import * as MessageProtocol from "./client/message_protocol";
import { IBot } from "./bot_logic/ibot";
import { IBehaviour } from "./behaviours/ibehaviour";
import { TeamController } from "./team/team_controller";
import { WorldMemory } from "./world/world_memory";

/**
 * Thin shell the runner instantiates. All the actual thinking lives in a
 * behaviour picked by TeamController — edit that file to change who does what.
 */
export class Bot implements IBot {
  // EDIT THIS FOR YOUR OWN BOT TOKEN
  public static readonly TOKEN = "BOTA-5a3y-D2Jk-C5yk";
  public static readonly TOKEN_B = "BOTB-5a3y-D2Jk-C5yk";

  private behaviour: IBehaviour | null = null;

  public getNextAction(
    state: MessageProtocol.GameState,
  ): MessageProtocol.ActionBase | null {
    if (!state.Bot) {
      return null;
    }

    // Map what we can see before deciding anything, so the knowledge is kept
    // whatever this bot is doing: a gatherer maps enemy machines for a later
    // raider, and a raider maps nodes for a later gatherer. Persisted, so a
    // restarted dev server does not start blind. See WorldMemory.
    WorldMemory.observe(state);

    // The runner creates every Bot the same way and never tells it which token
    // it connected with, so we wait for the server to say which bot we are.
    if (!this.behaviour) {
      this.behaviour = TeamController.behaviourFor(state.Bot.BotType);
      console.log(`[TEAM] ${state.Bot.BotType} is running the "${this.behaviour.name}" behaviour.`);
    }

    return this.behaviour.getNextAction(state);
  }
}

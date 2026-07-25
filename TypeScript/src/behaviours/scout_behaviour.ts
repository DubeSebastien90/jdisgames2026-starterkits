import * as MessageProtocol from "../client/message_protocol";
import { IBehaviour } from "./ibehaviour";

/**
 * TEMPLATE — copy this file to start a new behaviour.
 *
 * Three steps to plug one in:
 *   1. copy this file to src/behaviours/my_behaviour.ts
 *   2. rename the class
 *   3. point a bot at it in src/team/team_controller.ts
 *
 * This one just walks east and reports what it sees, so it is a safe thing to
 * hand a bot when you want it out of the gatherer's way.
 */
export class ScoutBehaviour implements IBehaviour {
  public readonly name = "scout";

  private static readonly REPORT_EVERY = 25;

  private lastReportTick = 0;

  public getNextAction(
    state: MessageProtocol.GameState,
  ): MessageProtocol.ActionBase | null {
    if (!state.Bot) {
      return null;
    }

    const pos = state.Bot.Position;

    if (state.CurrentTick - this.lastReportTick >= ScoutBehaviour.REPORT_EVERY) {
      this.lastReportTick = state.CurrentTick;
      console.log(
        `[${state.Bot.BotType}/scout] at ${pos.X},${pos.Y} | ` +
          `${state.VisibleResources.length} nodes, ${state.VisiblePlayers.length} players visible`,
      );
    }

    return new MessageProtocol.MoveAction(
      new MessageProtocol.Position(pos.X + 1, pos.Y),
    );
  }
}

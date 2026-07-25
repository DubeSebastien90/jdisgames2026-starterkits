import { Bot } from "./bot";
import { BotRunner } from "./bot_logic/bot_runner";

const URL_REMOTE = "https://jg26.jdis.ca";

/**
 * Which bot(s) this process drives. Pick at run time so nobody has to edit
 * this file (and fight over it in git):
 *
 *   npm run dev -- a        only BotA
 *   npm run dev -- b        only BotB
 *   npm run dev             both
 *
 * BOT=a npm run dev also works.
 */
const TOKENS: Record<string, string[]> = {
  a: [Bot.TOKEN],
  b: [Bot.TOKEN_B],
  both: [Bot.TOKEN, Bot.TOKEN_B],
};

const requested = (process.argv[2] ?? process.env.BOT ?? "both").toLowerCase();
const tokens = TOKENS[requested];

if (!tokens) {
  console.log(`[ERROR] Unknown bot "${requested}". Use one of: a, b, both.`);
  process.exit(1);
}

console.log(`Starting JDIS Bot Client (${requested})...`);
for (const token of tokens) {
  void BotRunner.run(URL_REMOTE, token).catch((error) => {
    console.log(`[ERROR] Bot runner crashed: ${String(error)}`);
  });
}

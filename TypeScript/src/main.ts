import { Bot } from "./bot";
import { BotRunner } from "./bot_logic/bot_runner";
import { quietProtocolLogs } from "./log_filter";

// Hide the client's per-action JSON dump. VERBOSE_PROTOCOL=1 brings it back.
quietProtocolLogs();

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

/**
 * Accepts "a", "-a" and "--a" anywhere in the arguments. Note that npm eats
 * flags written before the "--" separator: `npm run dev --a` never reaches us
 * and silently starts both bots, so `npm_config_a` is checked as a fallback.
 */
function requestedBot(): string {
  for (const arg of process.argv.slice(2)) {
    const cleaned = arg.replace(/^-+/, "").toLowerCase();
    if (TOKENS[cleaned]) {
      return cleaned;
    }
  }

  const fromEnv = process.env.BOT?.toLowerCase();
  if (fromEnv && TOKENS[fromEnv]) {
    return fromEnv;
  }

  // Set by npm when you write `npm run dev --a`.
  if (process.env.npm_config_a) {
    return "a";
  }
  if (process.env.npm_config_b) {
    return "b";
  }

  return "both";
}

const requested = requestedBot();
const tokens = TOKENS[requested];

console.log(`Starting JDIS Bot Client: ${requested.toUpperCase()}`);
for (const token of tokens) {
  console.log(`  -> ${token.slice(0, 4)}`);
}
for (const token of tokens) {
  void BotRunner.run(URL_REMOTE, token).catch((error) => {
    console.log(`[ERROR] Bot runner crashed: ${String(error)}`);
  });
}

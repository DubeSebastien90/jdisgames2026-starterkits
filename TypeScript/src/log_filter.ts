/**
 * Drops the client's per-action JSON dump from the console.
 *
 * GameClient prints "=== [BOT->SERVER] Sending JSON ===", the whole envelope
 * pretty-printed, and a rule of "=" for *every* action — six lines a tick, per
 * bot, which buries everything the behaviours say. That file must not be edited,
 * so the noise is filtered here instead of at the source.
 *
 * Set VERBOSE_PROTOCOL=1 to get it back when you need to see the wire format:
 *
 *   VERBOSE_PROTOCOL=1 npm run dev        (bash)
 *   $env:VERBOSE_PROTOCOL=1; npm run dev  (PowerShell)
 */
const HEADER = "=== [BOT->SERVER] Sending JSON ===";
const RULE = "===============================";

export function quietProtocolLogs(): void {
  if (process.env.VERBOSE_PROTOCOL) {
    return;
  }

  const original = console.log.bind(console);
  console.log = (...args: unknown[]): void => {
    const first = args.length > 0 ? args[0] : undefined;
    if (typeof first === "string" && isProtocolNoise(first)) {
      return;
    }
    original(...args);
  };
}

function isProtocolNoise(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === HEADER || trimmed === RULE) {
    return true;
  }

  // The envelope itself, printed as one multi-line string.
  return trimmed.startsWith("{") && trimmed.includes('"type": "COMMAND"');
}

import * as fs from "fs";
import * as path from "path";
import * as MessageProtocol from "../client/message_protocol";
import { EnemyIntel, KnownStructure } from "../team/enemy_intel";

/**
 * A resource node we have seen. Nodes do not move and their kind never changes,
 * so everything here except the amount is good forever. The amount is a snapshot:
 * it regenerates, and somebody may have mined it since.
 */
export interface KnownResource {
  readonly id: number;
  readonly name: string;
  readonly lootItem: string;
  readonly position: MessageProtocol.Position;
  readonly capacity: number;
  readonly canHostExtractor: boolean;
  readonly canHostPump: boolean;
  /** What was in it when we last looked. */
  readonly lastAmount: number;
  /** Cooldown the server reported at that moment, for ageing it forward later. */
  readonly lastRemainingTicks: number;
  readonly lastSeenTick: number;
}

/** The shape written to disk. Versioned so an old file is discarded, not misread. */
interface MemoryFile {
  version: number;
  /** Which team wrote it. A file from another team's run is not ours to trust. */
  teamId: number;
  /** Highest tick we saw. A lower tick on load means a new match started. */
  lastTick: number;
  resources: SerialisedResource[];
  structures: SerialisedStructure[];
  /** Liquid tiles as "x,y". Terrain, so the most durable thing in here. */
  liquid: string[];
}

interface SerialisedResource {
  id: number;
  name: string;
  lootItem: string;
  x: number;
  y: number;
  capacity: number;
  canHostExtractor: boolean;
  canHostPump: boolean;
  lastAmount: number;
  lastRemainingTicks: number;
  lastSeenTick: number;
}

interface SerialisedStructure {
  id: number;
  type: string;
  x: number;
  y: number;
  ownerTeamId: number;
  hp: number;
  maxHp: number;
  pvpActivated: boolean;
  lastSeenTick: number;
}

/**
 * What the team knows about the map, kept in a file so it survives a restart.
 *
 * Vision is small and the dev loop is short: every `npm run dev` starts a bot
 * that has never seen anything, so it re-explores ground it already mapped on the
 * last run. The map does not change during a match, which makes almost all of
 * this knowledge worth keeping:
 *
 * - Resource nodes: where they are, what they drop, whether a machine can go on
 *   them. Only the amount goes stale, and that is stored as "what it held when we
 *   last looked" rather than as truth.
 * - Enemy machines: where their pumps, extractors and radars are. Held by
 *   EnemyIntel while running; this only persists the durable half of it.
 * - Liquid tiles: terrain, so the one thing here that can never be wrong. Shared
 *   by every PathfindingMover, so one bot walking a shoreline maps it for both,
 *   and the next run starts knowing where the lakes are instead of finding each
 *   shore one refused move at a time.
 *
 * Deliberately NOT persisted: enemy bot positions. They move, so a position from
 * a previous run is worse than no information — it would send a fighter to a tile
 * an enemy stood on minutes ago.
 *
 * Staleness is handled by two checks on load. The file records the highest tick it
 * saw, and the server's tick only ever climbs within a match: a stored tick higher
 * than the current one means a new match, so the file is discarded. It also records
 * the team id, so a file written by another team's run is not read at all.
 */
export class WorldMemory {
  private static readonly VERSION = 2;
  // Ticks between writes. Cheap either way, but no reason to hit the disk every
  // tick when the interesting changes are minutes apart.
  private static readonly SAVE_EVERY = 100;
  /**
   * How far the tick may go backwards before we call it a new match. The server
   * can replay a tick or two around a reconnect, and throwing the map away for
   * that would defeat the point.
   */
  private static readonly TICK_SLACK = 20;

  private static readonly resources = new Map<number, KnownResource>();
  /** Liquid tiles as "x,y". See PathfindingMover, which reads and writes this. */
  private static readonly liquid = new Set<string>();
  private static loaded = false;
  private static teamId = 0;
  private static highestTick = 0;
  private static lastSaveTick = 0;
  private static dirty = false;
  private static exitHooked = false;

  /** Where the file lives. WORLD_MEMORY_FILE overrides it; "off" disables. */
  private static file(): string {
    return (
      process.env.WORLD_MEMORY_FILE ??
      path.resolve(process.cwd(), ".world-memory.json")
    );
  }

  private static enabled(): boolean {
    return process.env.WORLD_MEMORY_FILE !== "off";
  }

  /**
   * Record everything in sight. Call once per tick, from Bot, so it happens
   * whatever behaviour is running — a gatherer maps nodes for a later raider, and
   * a raider maps nodes for a later gatherer.
   */
  public static observe(state: MessageProtocol.GameState): void {
    if (!state.Bot) {
      return;
    }

    WorldMemory.ensureLoaded(state);

    const tick = state.CurrentTick;
    WorldMemory.highestTick = Math.max(WorldMemory.highestTick, tick);

    for (const resource of state.VisibleResources) {
      WorldMemory.resources.set(resource.Id, {
        id: resource.Id,
        name: resource.Name,
        lootItem: resource.LootItem,
        position: resource.Position,
        capacity: resource.Capacity,
        canHostExtractor: resource.CanHostExtractor,
        canHostPump: resource.CanHostPump,
        lastAmount: resource.CurrentAmount,
        lastRemainingTicks: resource.RemainingTicks,
        lastSeenTick: tick,
      });
      WorldMemory.dirty = true;
    }

    // Everything hostile, filtered on read rather than here: what is worth
    // attacking depends on the behaviour, but where it stands does not.
    EnemyIntel.record(state, false);
    WorldMemory.dirty = true;

    if (tick - WorldMemory.lastSaveTick >= WorldMemory.SAVE_EVERY) {
      WorldMemory.save();
    }
  }

  /** Every node we know of, nearest first. */
  public static knownResources(
    from: MessageProtocol.Position,
  ): KnownResource[] {
    return [...WorldMemory.resources.values()].sort(
      (a, b) =>
        WorldMemory.manhattan(from, a.position) -
        WorldMemory.manhattan(from, b.position),
    );
  }

  /** Nodes a machine of the given sort could go on, nearest first. */
  public static nodesHosting(
    from: MessageProtocol.Position,
    machine: "extractor" | "pump",
  ): KnownResource[] {
    return WorldMemory.knownResources(from).filter((node) =>
      machine === "pump" ? node.canHostPump : node.canHostExtractor,
    );
  }

  /**
   * The nearest remembered node worth walking to for a machine of this sort.
   *
   * Nodes currently in sight are skipped: the caller has already looked at those
   * and decided none of them will do, so offering them back would just have the
   * bot circling one node it cannot use. Same for ones it has written off.
   */
  public static nextHostSite(
    from: MessageProtocol.Position,
    machine: "extractor" | "pump",
    options: {
      visible: ReadonlySet<number>;
      skip?: ReadonlySet<number>;
    },
  ): KnownResource | null {
    for (const node of WorldMemory.nodesHosting(from, machine)) {
      if (options.visible.has(node.id)) {
        continue;
      }
      if (options.skip?.has(node.id)) {
        continue;
      }
      return node;
    }

    return null;
  }

  // ─── Terrain ────────────────────────────────────────────────────────────────

  /**
   * Note a liquid tile. Called by every PathfindingMover, so the shoreline one bot
   * discovers is known to the other one immediately and to the next run after a
   * restart. Terrain never changes, so nothing here ever needs invalidating.
   */
  public static rememberLiquid(key: string): void {
    if (!WorldMemory.liquid.has(key)) {
      WorldMemory.liquid.add(key);
      WorldMemory.dirty = true;
    }
  }

  public static isKnownLiquid(key: string): boolean {
    return WorldMemory.liquid.has(key);
  }

  /** Drop a node: mined out for good, or not where we thought it was. */
  public static forgetResource(id: number): void {
    if (WorldMemory.resources.delete(id)) {
      WorldMemory.dirty = true;
    }
  }

  public static summary(): string {
    return (
      `${WorldMemory.resources.size} nodes, ${EnemyIntel.summary()}, ` +
      `${WorldMemory.liquid.size} liquid tiles`
    );
  }

  // ─── File handling ──────────────────────────────────────────────────────────

  /**
   * Read the file, once, on the first tick that tells us who we are. Anything
   * unreadable, from another team, or from an earlier match is ignored rather
   * than repaired: re-exploring is cheap, acting on a wrong map is not.
   */
  private static ensureLoaded(state: MessageProtocol.GameState): void {
    if (WorldMemory.loaded) {
      return;
    }
    WorldMemory.loaded = true;
    WorldMemory.teamId = state.Team?.Id ?? 0;
    WorldMemory.hookExit();

    if (!WorldMemory.enabled()) {
      console.log("[MAP] World memory disabled by WORLD_MEMORY_FILE=off.");
      return;
    }

    const file = WorldMemory.file();
    let parsed: MemoryFile;

    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8")) as MemoryFile;
    } catch (error) {
      // Missing is the normal first run, so say nothing about it.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.log(`[MAP] Ignoring unreadable ${path.basename(file)}: ${String(error)}`);
      }
      return;
    }

    if (parsed.version !== WorldMemory.VERSION) {
      console.log(`[MAP] Ignoring a v${parsed.version} memory file, this build wants v${WorldMemory.VERSION}.`);
      return;
    }

    if (parsed.teamId !== WorldMemory.teamId) {
      console.log(
        `[MAP] Ignoring a memory file from team ${parsed.teamId}; we are team ${WorldMemory.teamId}.`,
      );
      return;
    }

    if (parsed.lastTick > state.CurrentTick + WorldMemory.TICK_SLACK) {
      console.log(
        `[MAP] Memory file stops at tick ${parsed.lastTick} but we are at ${state.CurrentTick}: ` +
          "new match, starting from scratch.",
      );
      return;
    }

    WorldMemory.restore(parsed);
    console.log(
      `[MAP] Loaded ${WorldMemory.summary()} from ${path.basename(file)} ` +
        `(last seen tick ${parsed.lastTick}).`,
    );
  }

  private static restore(parsed: MemoryFile): void {
    for (const node of parsed.resources ?? []) {
      WorldMemory.resources.set(node.id, {
        id: node.id,
        name: node.name,
        lootItem: node.lootItem,
        position: new MessageProtocol.Position(node.x, node.y),
        capacity: node.capacity,
        canHostExtractor: node.canHostExtractor,
        canHostPump: node.canHostPump,
        lastAmount: node.lastAmount,
        lastRemainingTicks: node.lastRemainingTicks ?? 0,
        lastSeenTick: node.lastSeenTick,
      });
    }

    for (const key of parsed.liquid ?? []) {
      WorldMemory.liquid.add(key);
    }

    EnemyIntel.restoreStructures(
      (parsed.structures ?? []).map((structure) => ({
        id: structure.id,
        type: structure.type,
        position: new MessageProtocol.Position(structure.x, structure.y),
        ownerTeamId: structure.ownerTeamId,
        hp: structure.hp,
        maxHp: structure.maxHp,
        pvpActivated: structure.pvpActivated,
        lastSeenTick: structure.lastSeenTick,
      })),
    );

    WorldMemory.highestTick = parsed.lastTick;
  }

  /**
   * Write the file. Goes to a temporary name first and is renamed into place, so
   * a bot killed mid-write leaves the previous map intact rather than half a one.
   */
  public static save(): void {
    if (!WorldMemory.enabled() || !WorldMemory.dirty) {
      return;
    }

    const payload: MemoryFile = {
      version: WorldMemory.VERSION,
      teamId: WorldMemory.teamId,
      lastTick: WorldMemory.highestTick,
      resources: [...WorldMemory.resources.values()].map((node) => ({
        id: node.id,
        name: node.name,
        lootItem: node.lootItem,
        x: node.position.X,
        y: node.position.Y,
        capacity: node.capacity,
        canHostExtractor: node.canHostExtractor,
        canHostPump: node.canHostPump,
        lastAmount: node.lastAmount,
        lastRemainingTicks: node.lastRemainingTicks,
        lastSeenTick: node.lastSeenTick,
      })),
      structures: EnemyIntel.snapshotStructures().map((structure) => ({
        id: structure.id,
        type: structure.type,
        x: structure.position.X,
        y: structure.position.Y,
        ownerTeamId: structure.ownerTeamId,
        hp: structure.hp,
        maxHp: structure.maxHp,
        pvpActivated: structure.pvpActivated,
        lastSeenTick: structure.lastSeenTick,
      })),
      liquid: [...WorldMemory.liquid],
    };

    const file = WorldMemory.file();
    const temporary = `${file}.tmp`;

    try {
      fs.writeFileSync(temporary, JSON.stringify(payload), "utf8");
      fs.renameSync(temporary, file);
      WorldMemory.lastSaveTick = WorldMemory.highestTick;
      WorldMemory.dirty = false;
    } catch (error) {
      console.log(`[MAP] Could not write ${path.basename(file)}: ${String(error)}`);
    }
  }

  /**
   * Save on the way out, so Ctrl-C keeps the run's discoveries. "exit" is the
   * hook to use: it is the last thing to run and allows synchronous work, which
   * an async SIGINT handler racing process.exit() does not.
   */
  private static hookExit(): void {
    if (WorldMemory.exitHooked) {
      return;
    }
    WorldMemory.exitHooked = true;
    process.on("exit", () => WorldMemory.save());
  }

  /** Forget everything, file included. For tests, and for starting clean. */
  public static reset(): void {
    WorldMemory.resources.clear();
    WorldMemory.liquid.clear();
    EnemyIntel.clear();
    WorldMemory.loaded = false;
    WorldMemory.teamId = 0;
    WorldMemory.highestTick = 0;
    WorldMemory.lastSaveTick = 0;
    WorldMemory.dirty = false;
  }

  private static manhattan(
    a: MessageProtocol.Position,
    b: MessageProtocol.Position,
  ): number {
    return Math.abs(a.X - b.X) + Math.abs(a.Y - b.Y);
  }
}

/** Re-exported so callers do not need to reach into two modules for one map. */
export type { KnownStructure };

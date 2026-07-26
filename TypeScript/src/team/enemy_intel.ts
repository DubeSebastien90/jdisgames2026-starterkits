import * as MessageProtocol from "../client/message_protocol";

/**
 * An enemy machine we have seen. Structures do not move, so a sighting stays
 * good until we go back and find it gone — there is no TTL on these.
 */
export interface KnownStructure {
  readonly id: number;
  readonly type: string;
  readonly position: MessageProtocol.Position;
  readonly ownerTeamId: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly pvpActivated: boolean;
  readonly lastSeenTick: number;
}

/**
 * An enemy bot we have seen with PVP on, i.e. one we could actually fight. These
 * walk around, so a sighting is a lead with a short shelf life, not a location.
 */
export interface KnownFighter {
  readonly playerId: number;
  readonly teamId: number;
  readonly botType: string | null;
  readonly position: MessageProtocol.Position;
  /** Health plus shield, since shield soaks damage first. */
  readonly hp: number;
  readonly lastSeenTick: number;
}

/**
 * What the team has seen worth attacking, kept across ticks.
 *
 * Vision is the reason this exists. GameState.updateVision() rebuilds
 * VisibleStructures and VisiblePlayers from scratch on every complete update, so
 * an enemy pump is forgotten the moment it leaves the vision radius — a fighter
 * that walks past an enemy outpost and then loses sight of it goes straight back
 * to sweeping blindly, as if it had never been there.
 *
 * Two kinds of memory, because the two kinds of target keep differently:
 *
 * - Structures never expire. They cannot move, so the only way a sighting goes
 *   wrong is the thing being destroyed, which is what forgetStructure() is for.
 * - Fighters expire after FIGHTER_TTL. A bot's last known tile is worth walking
 *   to for a few seconds and worthless after that.
 *
 * Like TeamClaims and TeamScouting this is per-process: both bots share it when
 * one main.ts drives them, and each keeps its own when they run separately.
 * Sharing is a bonus here, not a requirement — a lone bot still benefits from
 * remembering what it saw itself.
 */
export class EnemyIntel {
  /** Ticks before a bot's last known position stops being worth walking to. */
  private static readonly FIGHTER_TTL = 40;

  private static readonly structures = new Map<number, KnownStructure>();
  private static readonly fighters = new Map<number, KnownFighter>();

  /**
   * Note everything hostile in sight. Call once per tick, before reading.
   *
   * Only records what we could actually fight: enemy-owned, and with PVP on when
   * requirePvp is set. Something we are not allowed to damage is not intel, it is
   * a distraction.
   */
  public static record(
    state: MessageProtocol.GameState,
    requirePvp: boolean,
  ): void {
    const tick = state.CurrentTick;

    for (const structure of state.VisibleStructures) {
      if (structure.IsAlly) {
        continue;
      }
      if (requirePvp && !structure.PvpActivated) {
        continue;
      }

      EnemyIntel.structures.set(structure.Id, {
        id: structure.Id,
        type: structure.Type,
        position: structure.Position,
        ownerTeamId: structure.OwnerTeamId,
        hp: structure.Hp,
        maxHp: structure.MaxHp,
        pvpActivated: structure.PvpActivated,
        lastSeenTick: tick,
      });
    }

    for (const player of state.VisiblePlayers) {
      if (player.IsSelf || player.IsAlly || !player.Alive) {
        continue;
      }
      if (requirePvp && !player.PvpActivated) {
        continue;
      }

      EnemyIntel.fighters.set(player.PlayerId, {
        playerId: player.PlayerId,
        teamId: player.TeamId,
        botType: player.BotType,
        position: player.Position,
        hp: player.Health + player.Shield,
        lastSeenTick: tick,
      });
    }
  }

  /** Every enemy machine we know of, nearest first. */
  public static knownStructures(
    from: MessageProtocol.Position,
  ): KnownStructure[] {
    return [...EnemyIntel.structures.values()].sort(
      (a, b) =>
        EnemyIntel.manhattan(from, a.position) -
        EnemyIntel.manhattan(from, b.position),
    );
  }

  /** Enemy bots seen recently enough to be worth chasing, nearest first. */
  public static knownFighters(
    from: MessageProtocol.Position,
    tick: number,
  ): KnownFighter[] {
    const fresh: KnownFighter[] = [];

    for (const [id, fighter] of EnemyIntel.fighters) {
      if (tick - fighter.lastSeenTick > EnemyIntel.FIGHTER_TTL) {
        EnemyIntel.fighters.delete(id);
        continue;
      }
      fresh.push(fighter);
    }

    return fresh.sort(
      (a, b) =>
        EnemyIntel.manhattan(from, a.position) -
        EnemyIntel.manhattan(from, b.position),
    );
  }

  /** Is this machine one we already know about? */
  public static knowsStructure(id: number): boolean {
    return EnemyIntel.structures.has(id);
  }

  /**
   * Drop a machine from memory: we levelled it, or we went back and it was not
   * there. Without this a destroyed pump is a lead the team returns to forever.
   */
  public static forgetStructure(id: number): void {
    EnemyIntel.structures.delete(id);
  }

  /**
   * Drop a bot's last known position: we went there and it was not there, or it
   * was somewhere we cannot fight it. Without this a fighter parked in a safezone
   * is a lead the team walks back to until the TTL expires, over and over.
   */
  public static forgetFighter(playerId: number): void {
    EnemyIntel.fighters.delete(playerId);
  }

  /**
   * The durable half of what we know, for writing to disk. Fighters are left out
   * on purpose: they move, so a position from a previous run is worse than no
   * information at all. See WorldMemory.
   */
  public static snapshotStructures(): KnownStructure[] {
    return [...EnemyIntel.structures.values()];
  }

  /** Put a saved set back, without disturbing anything seen since. */
  public static restoreStructures(saved: readonly KnownStructure[]): void {
    for (const structure of saved) {
      if (!EnemyIntel.structures.has(structure.id)) {
        EnemyIntel.structures.set(structure.id, structure);
      }
    }
  }

  /** Everything we know, for a status line. */
  public static summary(): string {
    return `${EnemyIntel.structures.size} enemy structures, ${EnemyIntel.fighters.size} fighters`;
  }

  /** Wipe it. For tests, and for a fresh match in the same process. */
  public static clear(): void {
    EnemyIntel.structures.clear();
    EnemyIntel.fighters.clear();
  }

  private static manhattan(
    a: MessageProtocol.Position,
    b: MessageProtocol.Position,
  ): number {
    return Math.abs(a.X - b.X) + Math.abs(a.Y - b.Y);
  }
}

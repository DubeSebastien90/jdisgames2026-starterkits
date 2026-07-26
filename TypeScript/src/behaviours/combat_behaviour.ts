import * as MessageProtocol from "../client/message_protocol";
import { IBehaviour } from "./ibehaviour";
import { IMover } from "../movement/imover";
import { PathfindingMover } from "../movement/pathfinding_mover";
import { EnemyIntel } from "../team/enemy_intel";

type Phase = "hunt" | "approach" | "strike" | "explore";

/**
 * What a target is, which decides how it gets hit. The docs give one action per
 * kind: DestroyStructureAction "damages or destroys an external structure:
 * extractor, pump, or radar", and AttackAction "attacks a bot or companion".
 */
export type CombatTargetKind = "structure" | "player" | "companion";

export interface CombatOptions {
  /**
   * Skip targets whose PvpActivated flag is off, and stand down entirely while
   * our own team's flag is off. On by default: PVP is opt-in by both sides, and
   * swinging at something that cannot be hurt just parks the bot in enemy
   * territory for the rest of the match.
   */
  requirePvp?: boolean;
  /**
   * Skip targets standing in a safezone or a base zone, which the server does
   * not let anyone damage. On by default. Only tiles we can actually see are
   * judged — an unseen tile is assumed fair game, the same assumption the
   * pathfinder makes about unseen ground.
   */
  avoidProtectedZones?: boolean;
}

/**
 * One thing worth hitting, boiled down to what the fight loop needs. Structures
 * and people are found differently but chased and struck through this, so the
 * loop never touches the server's own types.
 */
export interface CombatTarget {
  readonly kind: CombatTargetKind;
  /**
   * The server's own word for it: "Pump", "Extractor", "Radar" for structures,
   * the BotType for a bot. Behaviours that rank by type read this rather than
   * picking the label apart.
   */
  readonly type: string;
  /** Stable across ticks, so a target can be remembered and written off. */
  readonly key: string;
  readonly position: MessageProtocol.Position;
  readonly hp: number;
  readonly maxHp: number;
  /** For the logs: "Pump at 12,4", "BotB at 30,17". */
  readonly label: string;
  /** Tiles covered, so a 2x2 pump counts as in range from any of its sides. */
  readonly width: number;
  readonly height: number;
}

/**
 * Shared fight loop: find something, walk to it with the pathfinder, hit it
 * until it stops existing, then find the next one. Everything except *which*
 * candidates count lives here — subclasses implement findTarget() and pick from
 * the scan helpers below.
 *
 * See DestroyBuildingBehaviour (structures only), DestroyPeopleBehaviour (bots
 * and companions) and DestroyEverythingBehaviour (nearest of the three).
 *
 * What the docs do NOT say, and what this therefore assumes:
 *
 * - Attack range. ATTACK_RANGE below is 1, i.e. you must be standing next to the
 *   target. If it turns out to reach further, raise it and the bot stops walking
 *   the last few tiles for nothing.
 * - Damage per swing, and any cooldown. Neither is modelled; the bot just swings
 *   every tick it is in range.
 *
 * Because those are guesses, the honest safety net is watching HP: a target
 * whose HP does not move over FUTILE_SWINGS hits cannot be hurt from here, for
 * whatever reason the server has, and gets written off. That covers PVP being
 * off, safezone rules, range being wrong, and anything else we cannot see.
 */
export abstract class CombatBehaviour implements IBehaviour {
  public abstract readonly name: string;

  /** Chebyshev tiles between us and the target's nearest tile. See above. */
  protected static readonly ATTACK_RANGE = 1;
  // Swings that land on a target whose HP never moves before we write it off.
  private static readonly FUTILE_SWINGS = 12;
  // How long a target we gave up on stays skipped.
  private static readonly IGNORE_TTL = 600;
  // Ticks of not moving while approaching before we pick a different target.
  private static readonly STUCK_LIMIT = 15;
  private static readonly EXPLORE_LEG = 20;
  // How far ahead to aim when sweeping for something to fight.
  private static readonly EXPLORE_AHEAD = 12;
  // Close enough to a remembered machine that we should be able to see it. Not
  // seeing it from here means it is gone, so the memory is dropped.
  private static readonly SIGHT_CONFIDENCE = 4;
  // Ticks of getting nowhere while walking to a remembered target before we stop
  // trusting that lead and go back to sweeping.
  private static readonly LEAD_PATIENCE = 25;
  // Ticks between repeats of the same standing-down message.
  private static readonly IDLE_LOG_EVERY = 40;
  private static readonly DIRECTIONS: { x: number; y: number; label: string }[] = [
    { x: 0, y: -1, label: "north" },
    { x: 1, y: 0, label: "east" },
    { x: 0, y: 1, label: "south" },
    { x: -1, y: 0, label: "west" },
  ];

  /** Avoids liquid, resources, structures and other bots. */
  protected readonly mover: IMover = new PathfindingMover();
  protected readonly requirePvp: boolean;
  protected readonly avoidProtectedZones: boolean;
  protected tag = "bot";

  private phase: Phase = "hunt";
  private targetKey: string | null = null;
  private targetPosition: MessageProtocol.Position | null = null;
  private lastTargetHp: number | null = null;
  private futileSwings = 0;
  private stuckTicks = 0;
  private exploreIndex = 0;
  private exploreTicksLeft = 0;
  private lastIdleLogTick = -CombatBehaviour.IDLE_LOG_EVERY;
  private readonly ignoredUntil = new Map<string, number>();
  /** Ticks spent walking to a remembered target without getting closer. */
  private leadStuckTicks = 0;
  /** Best distance reached toward the current lead, to tell progress from not. */
  private leadBestDistance = Number.POSITIVE_INFINITY;

  protected constructor(options: CombatOptions = {}) {
    this.requirePvp = options.requirePvp ?? true;
    this.avoidProtectedZones = options.avoidProtectedZones ?? true;
  }

  /** Nearest thing worth hitting, or null when nothing in sight qualifies. */
  protected abstract findTarget(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): CombatTarget | null;

  /** What we are hunting, for the "nothing in sight" log. */
  protected abstract quarry(): string;

  /**
   * Is a remembered target of this kind worth walking to when nothing is in
   * sight? Defaults to anything. Behaviours that fight only one pool override it,
   * or they march across the map toward something they would refuse to hit on
   * arrival — and then walk straight back, having remembered it again.
   */
  protected wantsLead(kind: CombatTargetKind, type: string): boolean {
    void kind;
    void type;
    return true;
  }

  public getNextAction(
    state: MessageProtocol.GameState,
  ): MessageProtocol.ActionBase | null {
    if (!state.Bot) {
      return null;
    }

    this.tag = state.Bot.BotType || "bot";
    const pos = state.Bot.Position;

    // Dead bots do not fight, and a dead bot still on its respawn cooldown does
    // nothing at all — this has to return outright rather than fall through, or
    // the fight loop below happily swings from the grave.
    const self = state.VisiblePlayers.find((player) => player.IsSelf) ?? null;
    if (this.isDead(state, self)) {
      return this.respawn(state, self);
    }

    // The mover needs this every tick, whatever we end up doing, or it cannot
    // tell a refused move from a successful one.
    this.mover.observe(state, pos);

    // Note what is in sight before deciding anything, so a target that goes out
    // of vision mid-chase is still somewhere we know to come back to. Recorded
    // unfiltered and filtered on read: whether a thing is worth attacking is this
    // behaviour's opinion, but where it stands is a fact worth keeping either way.
    // Bot also calls this through WorldMemory; setting the same key twice is free.
    EnemyIntel.record(state, false);

    if (this.requirePvp && state.Team && !state.Team.PvpActivated) {
      this.logIdle(
        state,
        "our own PVP flag is off, so nothing can be damaged. Standing down",
      );
      return null;
    }

    if (this.phase === "approach" || this.phase === "strike") {
      return this.fight(state, pos);
    }

    return this.hunt(state, pos);
  }

  // ─── Target scanning ────────────────────────────────────────────────────────

  /**
   * Every enemy structure of the given types that is worth a swing. The PVP,
   * zone and written-off filters are the same for all three pools, which is why
   * they live here rather than in each behaviour.
   */
  protected structureTargets(
    state: MessageProtocol.GameState,
    types: readonly string[],
  ): CombatTarget[] {
    const targets: CombatTarget[] = [];

    for (const structure of state.VisibleStructures) {
      if (structure.IsAlly || !types.includes(structure.Type)) {
        continue;
      }
      if (this.requirePvp && !structure.PvpActivated) {
        continue;
      }
      if (this.isIgnored(state, CombatBehaviour.structureKey(structure))) {
        continue;
      }
      if (this.inProtectedZone(state, structure.Position)) {
        continue;
      }

      targets.push(CombatBehaviour.asStructureTarget(structure));
    }

    return targets;
  }

  /** Every living enemy bot worth a swing. */
  protected playerTargets(state: MessageProtocol.GameState): CombatTarget[] {
    const targets: CombatTarget[] = [];

    for (const player of state.VisiblePlayers) {
      if (this.isUs(state, player) || this.isOurs(state, player) || !player.Alive) {
        continue;
      }
      if (this.requirePvp && !player.PvpActivated) {
        continue;
      }
      if (this.isIgnored(state, CombatBehaviour.playerKey(player))) {
        continue;
      }
      if (this.inProtectedZone(state, player.Position)) {
        continue;
      }

      targets.push(CombatBehaviour.asPlayerTarget(player));
    }

    return targets;
  }

  /**
   * Is this entry us?
   *
   * IsSelf alone is not enough. It is parsed with asBoolean, which falls back to
   * false when the server leaves the field out — and a bot that thinks it is not
   * itself is a valid enemy standing at range 0, so it spends a dozen ticks
   * attacking its own tile before the futility counter writes it off. The player
   * id is the fact behind the flag, so both are checked.
   */
  private isUs(
    state: MessageProtocol.GameState,
    player: MessageProtocol.VisiblePlayer,
  ): boolean {
    if (player.IsSelf) {
      return true;
    }
    const us = state.Bot?.Id ?? 0;
    return us !== 0 && player.PlayerId === us;
  }

  /** Is this entry a teammate? Same reasoning as isUs, via the team id. */
  private isOurs(
    state: MessageProtocol.GameState,
    entity: { IsAlly: boolean; TeamId: number },
  ): boolean {
    if (entity.IsAlly) {
      return true;
    }
    const ours = state.Team?.Id ?? 0;
    return ours !== 0 && entity.TeamId === ours;
  }

  /** Every enemy companion worth a swing. Soft, and carrying someone's loot. */
  protected companionTargets(state: MessageProtocol.GameState): CombatTarget[] {
    const targets: CombatTarget[] = [];

    for (const companion of state.VisibleCompanions) {
      if (this.isOurs(state, companion)) {
        continue;
      }
      if (this.requirePvp && !companion.PvpActivated) {
        continue;
      }
      if (this.isIgnored(state, CombatBehaviour.companionKey(companion))) {
        continue;
      }
      if (this.inProtectedZone(state, companion.Position)) {
        continue;
      }

      targets.push(CombatBehaviour.asCompanionTarget(companion));
    }

    return targets;
  }

  /** The closest of a set of candidates, by walking distance. Null when empty. */
  protected nearest(
    pos: MessageProtocol.Position,
    candidates: readonly CombatTarget[],
  ): CombatTarget | null {
    let best: CombatTarget | null = null;
    let bestCost = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
      const cost = this.travelDistance(pos, candidate);
      if (cost < bestCost) {
        bestCost = cost;
        best = candidate;
      }
    }

    return best;
  }

  // ─── The fight ──────────────────────────────────────────────────────────────

  private hunt(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    const target = this.findTarget(state, pos);
    if (!target) {
      return this.explore(state, pos);
    }

    this.targetKey = target.key;
    this.targetPosition = target.position;
    this.lastTargetHp = null;
    this.futileSwings = 0;
    this.stuckTicks = 0;
    this.phase = "approach";
    console.log(
      `[${this.tag}] Going after ${target.label} (${target.hp}/${target.maxHp} hp).`,
    );

    return this.fight(state, pos);
  }

  /** Close the gap, then swing. One tick does one or the other, never both. */
  private fight(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    if (this.targetKey === null) {
      return this.restartHunt(state, pos);
    }

    const target = this.refreshTarget(state, this.targetKey);

    if (!target) {
      // Out of vision while we were next to it means we finished it off.
      if (this.phase === "strike") {
        console.log(`[${this.tag}] ${this.describeTarget()} is gone.`);
        // A machine we levelled must leave the intel too, or the team keeps
        // walking back to the rubble for the rest of the match.
        this.forgetStructureTarget();
        return this.restartHunt(state, pos);
      }

      // Lost sight of it on the way in. Keep walking to where it was: for a
      // structure that is still where we left it, and for a bot it is the only
      // lead we have. Running out of patience is the STUCK_LIMIT check below.
      if (!this.targetPosition) {
        return this.restartHunt(state, pos);
      }
      return this.closeIn(state, pos, this.targetPosition);
    }

    this.targetPosition = target.position;

    if (this.rangeTo(pos, target) > CombatBehaviour.ATTACK_RANGE) {
      this.phase = "approach";
      return this.closeIn(state, pos, target.position);
    }

    this.phase = "strike";
    this.stuckTicks = 0;

    // Is the damage landing? HP that never drops means it cannot be hurt from
    // here, so stop feeding the match into it.
    if (this.lastTargetHp !== null && target.hp >= this.lastTargetHp) {
      this.futileSwings++;
      if (this.futileSwings >= CombatBehaviour.FUTILE_SWINGS) {
        console.log(
          `[${this.tag}] ${this.futileSwings} hits and ${target.label} is still ` +
            `${target.hp}/${target.maxHp} — protected zone, PVP off, or out of reach. Moving on.`,
        );
        return this.writeOffTarget(state, pos);
      }
    } else {
      if (this.lastTargetHp !== null) {
        console.log(`[${this.tag}] ${target.label} down to ${target.hp}/${target.maxHp} hp.`);
      }
      this.futileSwings = 0;
    }

    this.lastTargetHp = target.hp;
    return CombatBehaviour.strike(target);
  }

  /**
   * The same target as it looks this tick, or null when it is gone from vision.
   * People move, so this is what keeps the chase pointed at them.
   *
   * Deliberately unfiltered apart from death: a target we have already committed
   * to passed the filters when it was picked, and re-applying them here would
   * make us drop it the moment it steps onto a tile we cannot see the zone of.
   */
  private refreshTarget(
    state: MessageProtocol.GameState,
    key: string,
  ): CombatTarget | null {
    const structure = state.VisibleStructures.find(
      (candidate) => CombatBehaviour.structureKey(candidate) === key,
    );
    if (structure) {
      return CombatBehaviour.asStructureTarget(structure);
    }

    const player = state.VisiblePlayers.find(
      (candidate) => CombatBehaviour.playerKey(candidate) === key,
    );
    if (player) {
      // A dead bot is not worth swinging at while it waits to respawn.
      return player.Alive ? CombatBehaviour.asPlayerTarget(player) : null;
    }

    const companion = state.VisibleCompanions.find(
      (candidate) => CombatBehaviour.companionKey(candidate) === key,
    );
    return companion ? CombatBehaviour.asCompanionTarget(companion) : null;
  }

  /** The action that hurts this target, which is decided by what it is. */
  private static strike(target: CombatTarget): MessageProtocol.ActionBase {
    return target.kind === "structure"
      ? new MessageProtocol.DestroyStructureAction(target.position)
      : new MessageProtocol.AttackAction(target.position);
  }

  /**
   * One step toward the target, planned by the pathfinder.
   *
   * The target's own tile is occupied by definition, which the pathfinder treats
   * as blocked — except for the goal tile itself, which it always allows. So
   * aiming straight at the target works: it routes us to the edge, and we switch
   * to swinging before ever trying to step in.
   */
  private closeIn(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
    to: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    if (this.stuckTicks > CombatBehaviour.STUCK_LIMIT) {
      console.log(`[${this.tag}] Cannot get to ${this.describeTarget()}, looking elsewhere.`);
      return this.writeOffTarget(state, pos);
    }

    const step = this.mover.step(state, pos, to);
    if (!step || this.mover.lastMoveRefused) {
      this.stuckTicks++;
    } else {
      this.stuckTicks = 0;
    }

    return step;
  }

  /**
   * Nothing to fight in sight. Go back to something we remember before falling
   * back on sweeping at random — a machine we walked past ten ticks ago is a far
   * better bet than a direction.
   */
  private explore(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    const lead = this.followLead(state, pos);
    if (lead) {
      return lead;
    }

    return this.sweep(state, pos);
  }

  /**
   * Walk to the nearest thing EnemyIntel remembers. Returns null when there is
   * nothing worth walking to, which hands over to the blind sweep.
   */
  private followLead(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    const target = this.nearestLead(state, pos);
    if (!target) {
      this.resetLead();
      return null;
    }

    const distance = this.manhattan(pos, target.position);

    // Close enough to see it, and yet the hunt did not pick it as a target. So
    // either it is gone, or it is still standing but unusable — inside a safezone,
    // say. Either way the memory is not actionable from here, and keeping it would
    // have the team walking back to the same tile for the rest of the match.
    if (distance <= CombatBehaviour.SIGHT_CONFIDENCE) {
      const id = target.id;
      const fighterId = target.fighterId;

      // Close enough to see it, and yet the hunt did not pick it as a target. So
      // either it is gone, or it is still there but unusable — inside a safezone,
      // say. Either way the memory is not actionable and has to go, or we oscillate
      // beside the same tile for the rest of the match.
      if (id !== undefined) {
        const standing = state.VisibleStructures.some(
          (structure) => structure.Id === id,
        );
        EnemyIntel.forgetStructure(id);
        this.resetLead();
        this.logIdle(
          state,
          standing
            ? `the ${target.what} at ${target.position.X},${target.position.Y} is there but ` +
                "cannot be touched, forgetting it"
            : `nothing left at the remembered ${target.what} at ` +
                `${target.position.X},${target.position.Y}, forgetting it`,
        );
        return null;
      }

      if (fighterId !== undefined) {
        EnemyIntel.forgetFighter(fighterId);
        this.resetLead();
        this.logIdle(
          state,
          `${target.what} is not at ${target.position.X},${target.position.Y} any more ` +
            "(or cannot be touched there), looking elsewhere",
        );
        return null;
      }
    }

    // Getting no closer for a while means the way there is blocked. Sweeping is
    // more useful than pushing at it, and the memory stays for a later attempt.
    if (distance < this.leadBestDistance) {
      this.leadBestDistance = distance;
      this.leadStuckTicks = 0;
    } else if (++this.leadStuckTicks > CombatBehaviour.LEAD_PATIENCE) {
      this.resetLead();
      this.logIdle(state, `cannot get to the remembered ${target.what}, sweeping instead`);
      return null;
    }

    this.logIdle(
      state,
      `nothing in sight; heading for the remembered ${target.what} at ` +
        `${target.position.X},${target.position.Y} (${EnemyIntel.summary()})`,
    );

    return this.mover.step(state, pos, target.position);
  }

  /**
   * The closest remembered target. Machines first when they tie, since their
   * position is still true and a bot's is only where it used to be.
   */
  private nearestLead(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): {
    kind: CombatTargetKind;
    position: MessageProtocol.Position;
    what: string;
    /** Structure id, for dropping it from the intel when it is not there. */
    id?: number;
    /** Player id, same purpose. */
    fighterId?: number;
  } | null {
    for (const structure of EnemyIntel.knownStructures(pos)) {
      if (!this.wantsLead("structure", structure.type)) {
        continue;
      }
      // The store keeps everything it sees, so the PVP filter is applied here.
      if (this.requirePvp && !structure.pvpActivated) {
        continue;
      }
      // And the zone check, or we walk to something we will refuse to hit.
      if (this.inProtectedZone(state, structure.position)) {
        continue;
      }
      // Written off for being unhittable, so not worth the walk either.
      if (this.isIgnored(state, `structure:${structure.id}`)) {
        continue;
      }
      return {
        kind: "structure",
        position: structure.position,
        what: structure.type,
        id: structure.id,
      };
    }

    for (const fighter of EnemyIntel.knownFighters(pos, state.CurrentTick)) {
      const who = fighter.botType ?? `bot ${fighter.playerId}`;
      if (!this.wantsLead("player", who)) {
        continue;
      }
      if (this.isIgnored(state, `player:${fighter.playerId}`)) {
        continue;
      }
      if (this.inProtectedZone(state, fighter.position)) {
        continue;
      }
      return {
        kind: "player",
        position: fighter.position,
        what: who,
        fighterId: fighter.playerId,
      };
    }

    return null;
  }

  private resetLead(): void {
    this.leadStuckTicks = 0;
    this.leadBestDistance = Number.POSITIVE_INFINITY;
  }

  /**
   * Drop the current target from the intel, when it is a machine. The key is what
   * carries the id, since the target object itself is gone by the time we know it
   * was destroyed.
   */
  private forgetStructureTarget(): void {
    if (this.targetKey === null || !this.targetKey.startsWith("structure:")) {
      return;
    }

    const id = Number(this.targetKey.slice("structure:".length));
    if (Number.isFinite(id)) {
      EnemyIntel.forgetStructure(id);
    }
  }

  /** Last resort: pick a direction and cover ground. */
  private sweep(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    const blocked = this.mover.lastMoveRefused;

    if (this.phase !== "explore" || this.exploreTicksLeft <= 0 || blocked) {
      if (this.phase === "explore") {
        this.exploreIndex = (this.exploreIndex + 1) % CombatBehaviour.DIRECTIONS.length;
      }
      this.phase = "explore";
      this.exploreTicksLeft = CombatBehaviour.EXPLORE_LEG;
      this.logIdle(
        state,
        `no ${this.quarry()} in sight, sweeping ` +
          CombatBehaviour.DIRECTIONS[this.exploreIndex].label,
      );
    }

    this.exploreTicksLeft--;

    const dir = CombatBehaviour.DIRECTIONS[this.exploreIndex];
    return this.mover.step(
      state,
      pos,
      new MessageProtocol.Position(
        pos.X + dir.x * CombatBehaviour.EXPLORE_AHEAD,
        pos.Y + dir.y * CombatBehaviour.EXPLORE_AHEAD,
      ),
    );
  }

  // ─── Death ──────────────────────────────────────────────────────────────────

  /**
   * Our own entry in VisiblePlayers is where Alive and RespawnRemainingTicks are
   * reported, so it is the authority. Without one, a zero-health bot with a known
   * maximum is the only safe read — an unreported MaxHealth is also 0, which
   * would otherwise make every bot look dead on the first tick.
   */
  private isDead(
    state: MessageProtocol.GameState,
    self: MessageProtocol.VisiblePlayer | null,
  ): boolean {
    if (self) {
      return !self.Alive;
    }
    return !!state.Bot && state.Bot.MaxHealth > 0 && state.Bot.Health <= 0;
  }

  /**
   * Ask for a respawn, once the cooldown allows it. Asking early just gets
   * refused, so the wait is spent doing nothing.
   */
  private respawn(
    state: MessageProtocol.GameState,
    self: MessageProtocol.VisiblePlayer | null,
  ): MessageProtocol.ActionBase | null {
    // A fresh bot starts over: the old target is somewhere else entirely now.
    this.dropTarget();

    if (self && self.RespawnRemainingTicks > 0) {
      this.logIdle(state, `dead, respawn in ${self.RespawnRemainingTicks} ticks`);
      return null;
    }

    console.log(`[${this.tag}] Dead and off cooldown, respawning.`);
    return new MessageProtocol.RespawnAction();
  }

  // ─── Geometry and bookkeeping ───────────────────────────────────────────────

  /**
   * Tiles between us and the target's nearest tile: is it in reach?
   *
   * Manhattan, i.e. orthogonal adjacency, not chebyshev. The docs do not give an
   * attack range, but this codebase has already paid for the guess once — see the
   * note in StructureOnResourceBehaviour.walk(), where placing from a diagonal was
   * refused every time and the bot stood on the corner re-sending the same action
   * until it wrote off a node it could have used.
   *
   * The two mistakes are not symmetric. If attacks do reach diagonally, manhattan
   * costs us one extra step. If they do not, chebyshev costs a dozen refused swings
   * and a target written off as unhittable. So this takes the cautious one.
   */
  protected rangeTo(pos: MessageProtocol.Position, target: CombatTarget): number {
    const near = this.nearestTile(pos, target);
    return Math.abs(pos.X - near.X) + Math.abs(pos.Y - near.Y);
  }

  /** Plain tile distance between two points, for leads and rough ranking. */
  protected manhattan(
    a: MessageProtocol.Position,
    b: MessageProtocol.Position,
  ): number {
    return Math.abs(a.X - b.X) + Math.abs(a.Y - b.Y);
  }

  /** Manhattan distance to the nearest tile it covers: how far to walk. */
  protected travelDistance(
    pos: MessageProtocol.Position,
    target: CombatTarget,
  ): number {
    const near = this.nearestTile(pos, target);
    return Math.abs(pos.X - near.X) + Math.abs(pos.Y - near.Y);
  }

  /**
   * The tile of the target's footprint closest to us. Position is taken to be the
   * footprint's origin, so a 2x2 structure at 10,10 covers 10..11 on both axes.
   */
  private nearestTile(
    pos: MessageProtocol.Position,
    target: CombatTarget,
  ): MessageProtocol.Position {
    return new MessageProtocol.Position(
      Math.min(
        Math.max(pos.X, target.position.X),
        target.position.X + Math.max(target.width, 1) - 1,
      ),
      Math.min(
        Math.max(pos.Y, target.position.Y),
        target.position.Y + Math.max(target.height, 1) - 1,
      ),
    );
  }

  /**
   * Is this target standing somewhere its own side protects it?
   *
   * A zone shields the team that owns it, which is why ZoneOwnerTeamId matters and
   * the zone name alone is not enough. Judging by name alone means an enemy raiding
   * OUR base is filtered out and never attacked — our own base tiles have been seen
   * reporting Zone "SafeZone" (see the note on BaseGeometry.isAtBase), so the whole
   * of our own ground reads as untouchable.
   *
   * So this only refuses a target when the zone demonstrably belongs to that
   * target's team. Everything else is attempted, including unowned safezones,
   * because the zone strings have proven unreliable and the two mistakes are not
   * symmetric: a wrong "protected" means never swinging at all and no way to find
   * out, while a wrong "fair game" costs a few refused swings before the futility
   * check moves us on. Let the server be the authority on what it will allow.
   */
  protected inProtectedZone(
    state: MessageProtocol.GameState,
    position: MessageProtocol.Position,
    targetTeamId: number,
  ): boolean {
    if (!this.avoidProtectedZones) {
      return false;
    }

    const tile = state.getTileAt(position);
    if (!tile) {
      return false;
    }

    const zone = tile.Zone.toLowerCase();
    if (!zone.includes("safe") && !zone.includes("base")) {
      return false;
    }

    return tile.ZoneOwnerTeamId !== null && tile.ZoneOwnerTeamId === targetTeamId;
  }

  /** Has this target been written off, and is the ban still running? */
  protected isIgnored(state: MessageProtocol.GameState, key: string): boolean {
    const until = this.ignoredUntil.get(key);
    return until !== undefined && state.CurrentTick < until;
  }

  private writeOffTarget(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    if (this.targetKey !== null) {
      this.ignoredUntil.set(
        this.targetKey,
        state.CurrentTick + CombatBehaviour.IGNORE_TTL,
      );
    }
    return this.restartHunt(state, pos);
  }

  private restartHunt(
    state: MessageProtocol.GameState,
    pos: MessageProtocol.Position,
  ): MessageProtocol.ActionBase | null {
    this.dropTarget();
    return this.hunt(state, pos);
  }

  private dropTarget(): void {
    this.targetKey = null;
    this.targetPosition = null;
    this.lastTargetHp = null;
    this.futileSwings = 0;
    this.stuckTicks = 0;
    this.phase = "hunt";
  }

  private describeTarget(): string {
    return this.targetPosition
      ? `the target at ${this.targetPosition.X},${this.targetPosition.Y}`
      : "the target";
  }

  private logIdle(state: MessageProtocol.GameState, reason: string): void {
    if (state.CurrentTick - this.lastIdleLogTick < CombatBehaviour.IDLE_LOG_EVERY) {
      return;
    }
    this.lastIdleLogTick = state.CurrentTick;
    console.log(`[${this.tag}] ${reason}.`);
  }

  // ─── Turning server types into targets ──────────────────────────────────────

  private static asStructureTarget(
    structure: MessageProtocol.VisibleStructure,
  ): CombatTarget {
    return {
      kind: "structure",
      type: structure.Type,
      key: CombatBehaviour.structureKey(structure),
      position: structure.Position,
      hp: structure.Hp,
      maxHp: structure.MaxHp,
      label: `${structure.Type} at ${structure.Position.X},${structure.Position.Y}`,
      width: structure.Width,
      height: structure.Height,
    };
  }

  /** Shield soaks damage before health, so the two together are what we chew. */
  private static asPlayerTarget(
    player: MessageProtocol.VisiblePlayer,
  ): CombatTarget {
    const who = player.BotType ?? `bot ${player.PlayerId}`;
    return {
      kind: "player",
      type: who,
      key: CombatBehaviour.playerKey(player),
      position: player.Position,
      hp: player.Health + player.Shield,
      maxHp: player.MaxHealth + player.MaxShield,
      label: `${who} (team ${player.TeamId}) at ${player.Position.X},${player.Position.Y}`,
      width: 1,
      height: 1,
    };
  }

  private static asCompanionTarget(
    companion: MessageProtocol.VisibleCompanion,
  ): CombatTarget {
    return {
      kind: "companion",
      type: "companion",
      key: CombatBehaviour.companionKey(companion),
      position: companion.Position,
      hp: companion.Health,
      maxHp: companion.MaxHealth,
      label:
        `companion of team ${companion.TeamId} at ` +
        `${companion.Position.X},${companion.Position.Y} ` +
        `(carrying ${companion.InventoryItemsCount})`,
      width: 1,
      height: 1,
    };
  }

  /**
   * Id, falling back to the tile when the server reports 0 for everything. A
   * structure does not move, so its position is as good an identity.
   */
  private static structureKey(
    structure: MessageProtocol.VisibleStructure,
  ): string {
    return structure.Id !== 0
      ? `structure:${structure.Id}`
      : `structure@${structure.Position.X},${structure.Position.Y}`;
  }

  private static playerKey(player: MessageProtocol.VisiblePlayer): string {
    return `player:${player.PlayerId}`;
  }

  private static companionKey(
    companion: MessageProtocol.VisibleCompanion,
  ): string {
    return `companion:${companion.CompanionId}`;
  }
}

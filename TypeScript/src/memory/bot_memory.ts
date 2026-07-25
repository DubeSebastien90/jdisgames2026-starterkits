import { Position } from "../client/message_protocol";
import { samePosition } from "../core/types";

/**
 * Agent memory: facts about the world, created once and never replaced.
 * Survives every strategy swap — that is why it lives on the agent.
 *
 * Every write goes through a method so a strategy can never reassign the shared
 * reference out from under the agent.
 */
/** Ticks a resource stays blacklisted after a failed gather attempt. */
const BLOCK_COOLDOWN = 60;

export class BotMemory {
  private anchor: Position | null = null;
  private lastPosition: Position | null = null;
  private stuckTicks = 0;
  private blockedResources = new Map<number, number>(); // resourceId -> tick blocked
  private lastUnitsCarried = -1;
  private noPickupTicks = 0;
  private packFull = false;

  /** The point we consider "home". Recorded once, on the first tick we see. */
  public rememberAnchor(position: Position): void {
    if (this.anchor === null) {
      this.anchor = position;
    }
  }

  public getAnchor(): Position | null {
    return this.anchor;
  }

  /**
   * Called by the agent every tick. If our position did not change, the last
   * move was refused (wall, water, occupied tile) — strategies read `stuckFor()`
   * to give up on an unreachable target instead of shoving into it forever.
   */
  public observePosition(position: Position): void {
    if (this.lastPosition !== null && samePosition(this.lastPosition, position)) {
      this.stuckTicks += 1;
    } else {
      this.stuckTicks = 0;
    }

    this.lastPosition = position;
  }

  public stuckFor(): number {
    return this.stuckTicks;
  }

  public clearStuck(): void {
    this.stuckTicks = 0;
  }

  /**
   * A resource we asked for and got nothing from: unreachable, contested, or the
   * server refused it. Skipped until the cooldown expires, so a bad node can
   * never trap us but is retried eventually.
   */
  public blockResource(resourceId: number, tick: number): void {
    this.blockedResources.set(resourceId, tick);
  }

  public isResourceBlocked(resourceId: number, now: number): boolean {
    const blockedAt = this.blockedResources.get(resourceId);
    if (blockedAt === undefined) {
      return false;
    }

    if (now - blockedAt > BLOCK_COOLDOWN) {
      this.blockedResources.delete(resourceId);
      return false;
    }

    return true;
  }

  /**
   * Called every tick we ask to gather. The item count is ground truth: if it
   * stops rising we are either full or gathering nothing, and the gather goal
   * uses `noPickupFor()` to tell those apart and move on.
   */
  public noteGatherAttempt(unitsCarried: number): void {
    if (this.lastUnitsCarried >= 0 && unitsCarried <= this.lastUnitsCarried) {
      this.noPickupTicks += 1;
    } else {
      this.noPickupTicks = 0;
    }

    this.lastUnitsCarried = unitsCarried;
  }

  public noPickupFor(): number {
    return this.noPickupTicks;
  }

  public clearGatherProgress(): void {
    this.lastUnitsCarried = -1;
    this.noPickupTicks = 0;
  }

  /**
   * "We are carrying as much as the server will let us." Set by the gather goal
   * when items stop arriving, and it has to live here rather than on the
   * strategy: the whole point is that the agent still knows it *after* swapping
   * to the delivery goal, otherwise it would just pick gathering again.
   *
   * `PlayerInfo.Slots` only counts distinct stacks, so a bot hauling one item
   * type is never "full" by that measure — this is the flag that actually stops
   * a gather trip.
   */
  public markPackFull(): void {
    this.packFull = true;
  }

  public isPackFull(): boolean {
    return this.packFull;
  }

  /** Ground truth, every tick: an empty pack is never full. Self-corrects on deposit. */
  public observeInventory(unitsCarried: number): void {
    if (unitsCarried === 0) {
      this.packFull = false;
    }
  }
}

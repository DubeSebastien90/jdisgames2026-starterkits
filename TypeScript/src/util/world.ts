import { BaseInfo, PlayerInfo, Position, Resource } from "../client/message_protocol";
import { BotContext, distance } from "../core/types";
import { BotMemory } from "../memory/bot_memory";

/** Total items carried, all stacks combined. */
export function inventoryUnits(player: PlayerInfo): number {
  return player.Inventory.reduce((total, stack) => total + stack.Quantity, 0);
}

/** Inventory slots are stacks: one slot per distinct item. */
export function isInventoryFull(player: PlayerInfo): boolean {
  return player.Slots > 0 && player.Inventory.length >= player.Slots;
}

/**
 * A tile inside the base to walk to. `Position` + half the extents lands inside
 * the footprint whether the server anchors the rect at its corner or its centre.
 */
export function baseTarget(base: BaseInfo): Position {
  return new Position(
    base.Position.X + Math.floor(base.Width / 2),
    base.Position.Y + Math.floor(base.Height / 2),
  );
}

/**
 * Closest resource still worth walking to: has something left, and is not
 * blacklisted from a failed attempt.
 */
export function nearestGatherable(ctx: BotContext, memory: BotMemory): Resource | null {
  let best: Resource | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const resource of ctx.state.VisibleResources) {
    if (resource.CurrentAmount <= 0 || memory.isResourceBlocked(resource.Id, ctx.tick)) {
      continue;
    }

    const away = distance(ctx.self.Position, resource.Position);
    if (away < bestDistance) {
      best = resource;
      bestDistance = away;
    }
  }

  return best;
}

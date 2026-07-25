import * as MessageProtocol from "../client/message_protocol";

/**
 * The resource vocabulary, as a type.
 *
 * The protocol sends resources as free text (`Name` is a display name like
 * "Sugar Cane", `LootItem` an id like "sugar_cane"), so a behaviour that wants
 * *one* kind of node would otherwise take a string and silently do nothing when
 * it is misspelled. These are the names the server uses — the liquids match the
 * TerrainType enum the other starter kits ship — so asking for the wrong one is
 * a compile error instead of a bot that stands still all game.
 *
 * Add a name here the moment the server shows one we did not know about.
 */
export type ResourceKind =
  | "sugar_cane"
  | "soda"
  | "licorice"
  | "fudge"
  | "maple_syrup"
  | "sap"
  | "sorbet"
  | "vanilla"
  | "cotton_candy"
  | "corn_syrup";

export const RESOURCE_KINDS: readonly ResourceKind[] = [
  "sugar_cane",
  "soda",
  "licorice",
  "fudge",
  "maple_syrup",
  "sap",
  "sorbet",
  "vanilla",
  "cotton_candy",
  "corn_syrup",
];

/** The liquids, i.e. the ones a pump goes on. Handy as a group. */
export const LIQUID_RESOURCE_KINDS: readonly ResourceKind[] = [
  "corn_syrup",
  "maple_syrup",
  "vanilla",
  "soda",
];

/** "Maple Syrup", "maple-syrup", "MAPLE_SYRUP" all become "maple_syrup". */
export function normalizeResourceName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function isResourceKind(value: string): value is ResourceKind {
  return (RESOURCE_KINDS as readonly string[]).includes(normalizeResourceName(value));
}

/** Human-friendly spelling for logs: "maple_syrup" -> "maple syrup". */
export function resourceKindLabel(kind: ResourceKind): string {
  return kind.replace(/_/g, " ");
}

/**
 * Is this node one of the kinds we asked for?
 *
 * Checks both spellings the server uses (display name and loot item id) and
 * matches on substring, so "Maple Syrup Pool" or "maple_syrup_bottle" still
 * count as maple syrup.
 */
export function matchesResourceKind(
  resource: MessageProtocol.Resource,
  kinds: readonly ResourceKind[],
): boolean {
  const name = normalizeResourceName(resource.Name);
  const loot = normalizeResourceName(resource.LootItem);

  return kinds.some((kind) => name.includes(kind) || loot.includes(kind));
}

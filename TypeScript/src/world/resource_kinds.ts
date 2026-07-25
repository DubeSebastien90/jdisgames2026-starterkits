import * as MessageProtocol from "../client/message_protocol";

/**
 * The resource vocabulary, as a type.
 *
 * The protocol sends resources as free text, and it uses two different names for
 * the same thing: the *node* is named after its terrain ("Sorbet") while the
 * *loot* is what comes out of it ("Ice Cream"). Both are accepted here, because
 * they are not interchangeable — a Sorbet node drops either Ice Cream or Mint,
 * so asking for "sorbet" gets you whichever one you walked into, and asking for
 * "ice_cream" gets you the one you meant.
 *
 * Taken from the docs' Encyclopedia of Resources:
 * https://gitlabbe.github.io/jdisgames2026-docs/resources/resource-nodes
 */
export type ResourceNodeKind =
  | "cotton_candy"
  | "corn_syrup"
  | "fudge"
  | "sap"
  | "maple_syrup"
  | "sorbet"
  | "vanilla"
  | "licorice"
  | "soda";

export type LootKind =
  | "sugar_cane"
  | "corn_syrup"
  | "dark_chocolate"
  | "white_chocolate"
  | "milk_chocolate"
  | "waffle"
  | "maple_syrup"
  | "ice_cream"
  | "mint"
  | "vanilla"
  | "gelatin"
  | "nut"
  | "soda";

/** Either spelling. This is what the behaviours take. */
export type ResourceKind = ResourceNodeKind | LootKind;

/** What a node can be automated with. Land takes extractors, liquid takes pumps. */
export type Automation = "extractor" | "pump";

export interface ResourceNodeInfo {
  node: ResourceNodeKind;
  loot: LootKind;
  automation: Automation;
  /** Items in a full node. */
  capacity: number;
  /** Seconds to refill once emptied — not ticks. */
  respawnSeconds: number;
}

/**
 * The whole table, straight from the docs. Useful beyond matching: capacity and
 * respawn are what make one node worth walking to over another (Cotton Candy is
 * 140 every 180s, Soda is 60 every 720s — an order of magnitude apart).
 */
export const RESOURCE_NODES: readonly ResourceNodeInfo[] = [
  { node: "cotton_candy", loot: "sugar_cane", automation: "extractor", capacity: 140, respawnSeconds: 180 },
  { node: "corn_syrup", loot: "corn_syrup", automation: "pump", capacity: 120, respawnSeconds: 240 },
  { node: "fudge", loot: "dark_chocolate", automation: "extractor", capacity: 90, respawnSeconds: 420 },
  { node: "fudge", loot: "white_chocolate", automation: "extractor", capacity: 90, respawnSeconds: 420 },
  { node: "fudge", loot: "milk_chocolate", automation: "extractor", capacity: 100, respawnSeconds: 300 },
  { node: "sap", loot: "waffle", automation: "extractor", capacity: 100, respawnSeconds: 300 },
  { node: "maple_syrup", loot: "maple_syrup", automation: "pump", capacity: 100, respawnSeconds: 330 },
  { node: "sorbet", loot: "ice_cream", automation: "extractor", capacity: 80, respawnSeconds: 420 },
  { node: "sorbet", loot: "mint", automation: "extractor", capacity: 75, respawnSeconds: 480 },
  { node: "vanilla", loot: "vanilla", automation: "pump", capacity: 75, respawnSeconds: 480 },
  { node: "licorice", loot: "gelatin", automation: "extractor", capacity: 70, respawnSeconds: 540 },
  { node: "licorice", loot: "nut", automation: "extractor", capacity: 70, respawnSeconds: 600 },
  { node: "soda", loot: "soda", automation: "pump", capacity: 60, respawnSeconds: 720 },
];

/** Every name that means something, both spellings. */
export const RESOURCE_KINDS: readonly ResourceKind[] = [
  ...new Set<ResourceKind>(RESOURCE_NODES.flatMap((info) => [info.node, info.loot])),
];

/** The liquids, i.e. what a pump goes on. */
export const LIQUID_RESOURCE_KINDS: readonly ResourceKind[] = [
  ...new Set<ResourceKind>(
    RESOURCE_NODES.filter((info) => info.automation === "pump").flatMap((info) => [
      info.node,
      info.loot,
    ]),
  ),
];

/** The land nodes, i.e. what an extractor goes on. */
export const LAND_RESOURCE_KINDS: readonly ResourceKind[] = [
  ...new Set<ResourceKind>(
    RESOURCE_NODES.filter((info) => info.automation === "extractor").flatMap((info) => [
      info.node,
      info.loot,
    ]),
  ),
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

/** Rows of the table this name covers — several when a node has two loots. */
export function resourceNodesFor(kind: ResourceKind): ResourceNodeInfo[] {
  return RESOURCE_NODES.filter((info) => info.node === kind || info.loot === kind);
}

/**
 * Extractor or pump? Null when the name covers both (no such name today, but
 * the table is the authority, not this comment).
 */
export function automationFor(kind: ResourceKind): Automation | null {
  const rows = resourceNodesFor(kind);
  if (rows.length === 0) {
    return null;
  }
  const first = rows[0].automation;
  return rows.every((info) => info.automation === first) ? first : null;
}

/**
 * Is this node one of the kinds we asked for?
 *
 * Checks both names the server uses (node name and loot item) and matches on
 * whole words, so "ice_cream" hits a node called "Ice Cream" or one whose loot
 * is "ice_cream", while "nut" never matches a "Nutmeg" that shows up later.
 */
export function matchesResourceKind(
  resource: MessageProtocol.Resource,
  kinds: readonly ResourceKind[],
): boolean {
  const name = normalizeResourceName(resource.Name);
  const loot = normalizeResourceName(resource.LootItem);

  return kinds.some((kind) => containsKind(name, kind) || containsKind(loot, kind));
}

/** Exact match, or the kind appearing as whole underscore-separated words. */
function containsKind(value: string, kind: ResourceKind): boolean {
  if (value === kind) {
    return true;
  }
  return (
    value.startsWith(`${kind}_`) ||
    value.endsWith(`_${kind}`) ||
    value.includes(`_${kind}_`)
  );
}

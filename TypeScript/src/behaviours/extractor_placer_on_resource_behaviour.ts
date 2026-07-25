import * as MessageProtocol from "../client/message_protocol";
import {
  StructureOnResourceBehaviour,
  StructureOnResourceOptions,
} from "./structure_on_resource_behaviour";
import { ResourceKind } from "../world/resource_kinds";

/**
 * ExtractorPlacerBehaviour, but picky: it only ever places on the resource kind
 * (or kinds) you name, and explores instead of giving up when none is in sight.
 * A node that is locked by its regen cooldown still counts as a target — the bot
 * waits beside it — unless you pass includeLocked: false.
 *
 *   new ExtractorPlacerOnResourceBehaviour("sugar_cane")
 *   new ExtractorPlacerOnResourceBehaviour(["sugar_cane", "licorice"])
 *   new ExtractorPlacerOnResourceBehaviour("sugar_cane", { includeLocked: false })
 *
 * The plain ExtractorPlacerBehaviour still exists and still takes whatever node
 * is nearest — use that when you do not care what you tap.
 */
export class ExtractorPlacerOnResourceBehaviour extends StructureOnResourceBehaviour {
  protected readonly structureType = "Extractor";

  public constructor(
    kinds: ResourceKind | readonly ResourceKind[],
    options: StructureOnResourceOptions = {},
  ) {
    super("extractor-placer", kinds, options);
  }

  protected canHost(resource: MessageProtocol.Resource): boolean {
    return resource.CanHostExtractor;
  }

  protected placeAction(
    position: MessageProtocol.Position,
  ): MessageProtocol.ActionBase {
    return new MessageProtocol.PlaceExtractorAction(position);
  }
}

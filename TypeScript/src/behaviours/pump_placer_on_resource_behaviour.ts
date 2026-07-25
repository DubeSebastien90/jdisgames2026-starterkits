import * as MessageProtocol from "../client/message_protocol";
import {
  StructureOnResourceBehaviour,
  StructureOnResourceOptions,
} from "./structure_on_resource_behaviour";
import { ResourceKind } from "../world/resource_kinds";

/**
 * PumpPlacerBehaviour, but picky: it only ever pumps the liquid kind (or kinds)
 * you name instead of the nearest pumpable node. A node that is locked by its
 * regen cooldown still counts as a target — the bot waits beside it — unless you
 * pass includeLocked: false.
 *
 *   new PumpPlacerOnResourceBehaviour("maple_syrup")
 *   new PumpPlacerOnResourceBehaviour(LIQUID_RESOURCE_KINDS)  // same as the old one
 *   new PumpPlacerOnResourceBehaviour("maple_syrup", { includeLocked: false })
 *
 * The plain PumpPlacerBehaviour still exists and still takes whatever liquid is
 * nearest — use that when you do not care what you pump.
 */
export class PumpPlacerOnResourceBehaviour extends StructureOnResourceBehaviour {
  protected readonly structureType = "Pump";

  public constructor(
    kinds: ResourceKind | readonly ResourceKind[],
    options: StructureOnResourceOptions = {},
  ) {
    super("pump-placer", kinds, options);
  }

  protected canHost(resource: MessageProtocol.Resource): boolean {
    return resource.CanHostPump;
  }

  protected placeAction(
    position: MessageProtocol.Position,
  ): MessageProtocol.ActionBase {
    return new MessageProtocol.PlacePumpAction(position);
  }
}

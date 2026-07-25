/**
 * Shared between every behaviour in the process so two bots do not walk to the
 * same resource node and then jostle over the one tile next to it.
 *
 * A claim is a soft reservation: the owner refreshes it every tick while it is
 * working the node, and it lapses on its own if the owner dies, changes target
 * or is restarted. Nothing has to remember to release it.
 */
export class TeamClaims {
  /** A claim not refreshed within this many ticks is treated as abandoned. */
  private static readonly CLAIM_TTL = 10;

  private static readonly claims = new Map<number, { owner: string; tick: number }>();

  /** Mark a node as being worked by `owner`. Call every tick while on it. */
  public static claim(nodeId: number, owner: string, tick: number): void {
    TeamClaims.claims.set(nodeId, { owner, tick });
  }

  /** True when somebody else is actively working this node. */
  public static takenByOther(nodeId: number, owner: string, tick: number): boolean {
    const claim = TeamClaims.claims.get(nodeId);
    if (!claim || claim.owner === owner) {
      return false;
    }

    if (tick - claim.tick > TeamClaims.CLAIM_TTL) {
      TeamClaims.claims.delete(nodeId);
      return false;
    }

    return true;
  }

  public static release(nodeId: number, owner: string): void {
    if (TeamClaims.claims.get(nodeId)?.owner === owner) {
      TeamClaims.claims.delete(nodeId);
    }
  }
}

# Agent + Strategy + Memory Architecture

A pattern for building a game agent (combat, movement, whatever) whose behavior
can change **mid-fight** without losing the state that matters, built on top of
the classic Strategy pattern in TypeScript.

> **Reading this to add a behavior?** Jump to
> [Where does a new behavior go?](#where-does-a-new-behavior-go) — it maps a plain
> request ("retreat when low HP") to the exact layer the code belongs in.

---

## The big picture

There are three roles, and keeping them separate is the whole point:

1. **The Agent** — the brain. It holds memory, holds the currently-active
   strategy implementations, and decides *which* strategy to run. It does **not**
   make the actual move/shoot decision itself.
2. **The Strategies** — the hands. Each action is defined by an **interface** (a
   contract) and has multiple swappable **implementations**. The strategy makes
   the *actual* decision. Strategies can also be **layered** — a high-level goal
   strategy can delegate to a low-level movement strategy (see
   [Hierarchy](#hierarchy-strategies-inside-strategies)).
3. **The Memory** — the notebook. Data the agent remembers. It can have several
   distinct memory members, each remembering a different kind of data.

> **The agent decides *what* strategy to use. The strategy makes the *actual*
> decision.**

---

## Two kinds of memory

This is the core distinction of the whole design.

### Agent memory (a.k.a. system memory)

- Lives on the **agent**, created once, and **never replaced** for the life of the fight.
- Holds facts about the **world / the fight** — things any strategy should respect.
- Handed (by reference) to strategies so they can read *and write* it.
- **Survives strategy swaps.** That's the entire reason it lives on the agent
  instead of inside a strategy.
- The agent can have **multiple memory members**, each remembering a different
  kind of data (e.g. one for claimed targets, one for the current strategy).

### Implementation memory (a.k.a. strategy memory)

- Lives as a **field on a strategy instance**.
- Holds that algorithm's **private scratch state** — its own working-out.
- **Disposable by design.** It is *correctly* thrown away when the strategy stops.
- Exists mainly so the strategy doesn't recompute expensive work every tick
  (e.g. caching an A* path and only recomputing when the map/target changes), and
  to hold a nested sub-strategy's identity (which mover a goal is currently using).

### The test that decides where state goes

> **"If I swap the strategy, should this be forgotten?"**
>
> - **Yes → strategy field** (implementation memory). It was private scratch.
> - **No → agent memory.** It was a fact about the world all along.

And the sharper corollary:

> **Strategy memory is disposable by design. If you ever *wish* it weren't,
> that's proof it should have been agent memory.**

For a team of your own bots, apply the test one level higher: *"if this agent
dies, should this be forgotten?"* No → it's **team memory**, one level above the
agent (see [Limits](#known-limits)).

---

## Why memory edits work through a passed-in argument

When the agent passes `this.memory` into `strategy.decide(ctx, memory)`,
TypeScript passes the **reference**, not a copy. So the `memory` parameter inside
the strategy and the agent's field point at the **same object**.

```ts
decide(ctx, memory: BulletMemory) {
  memory.claim("enemy_3", ctx.now); // ✅ mutates the shared object — agent sees it
  memory = new BulletMemory();      // ❌ only rebinds the local param — agent untouched
}
```

- **Reaching *through* the reference** (calling a method on it) → shared, the agent sees it.
- **Replacing the reference** (reassigning the variable) → local only, the agent sees nothing.

This is why memory exposes **methods** (`claim` / `release` / `isClaimed`) and
keeps its internal map **private**: every write goes through a named door you can
log or breakpoint, and there's no way to accidentally reassign the shared state.

**Nesting rule for memory:** if a strategy delegates to a sub-strategy that needs
agent memory, the outer contract must **accept and forward** it. The outer
contract has to be a *superset* of what any inner layer needs from outside.
Implementation memory (the A* cache) is internal and never threaded; shared agent
memory is threaded through every layer that needs it.

---

## The contracts (interfaces)

Each action is a contract. The signature usually includes the **context from the
API** plus whatever **agent memory** that action needs to read/write. Different
layers have different contracts.

```ts
type Move = "up" | "down" | "left" | "right" | "stay";
type Shot = { fire: true; targetX: number; targetY: number } | { fire: false };

interface FightContext {
  myX: number;
  myY: number;
  hp: number;
  baseX: number;
  baseY: number;
  enemyBaseX: number;
  enemyBaseY: number;
  now: number;          // current tick
  enemies: Enemy[];
  coins: Coin[];
  bullets: Bullet[];    // live bullets on the map, from the API
  map: GameMap;
}

// ---- GOAL layer: decides WHERE to go + whether we're there yet ----
// Owns a destination. Delegates the actual step to a MoveStrategy.
interface GoalStrategy {
  readonly name: string;
  decide(ctx: FightContext, memory: BulletMemory): { move: Move; arrived: boolean };
}

// ---- MOVE layer: pure pather. Told WHERE, only answers HOW to step ----
interface MoveStrategy {
  readonly name: string;
  step(ctx: FightContext, targetX: number, targetY: number, memory: BulletMemory): Move;
}

// ---- SHOOT: independent action, decided alongside movement ----
interface ShootStrategy {
  readonly name: string;
  decide(ctx: FightContext, memory: BulletMemory): Shot;
}
```

The `name` field lets the agent ask "am I already running this?" cheaply.

**Why the split.** "Where do I want to go" and "how do I step there" are
orthogonal questions, so the good behaviors are the *cross* combinations:
`Attack` goal + `CollectCoins` mover = "push the enemy base but grab coins on the
way", for free, from 3 goals × 2 movers instead of 6 hand-written classes.
`arrived` is computed at the **goal** layer (it owns the destination); the mover
stays dumb and reusable and never needs to know about `arrived`.

---

## Hierarchy: strategies inside strategies

A strategy is just an object, so nothing stops it from holding and calling
another one. A **goal** strategy owns a destination and delegates the step to a
**move** strategy it holds in its own implementation memory.

```ts
// GOAL implementations — each owns a destination, delegates the step
class Retreat implements GoalStrategy {
  readonly name = "Retreat";
  private mover: MoveStrategy = new FastestPath(); // sub-strategy in impl-memory

  decide(ctx: FightContext, memory: BulletMemory) {
    const arrived = ctx.myX === ctx.baseX && ctx.myY === ctx.baseY;
    const move = arrived ? "stay" : this.mover.step(ctx, ctx.baseX, ctx.baseY, memory);
    return { move, arrived };
  }
}

class Attack implements GoalStrategy {
  readonly name = "Attack";
  // wants coins on the way in -> holds a different mover
  private mover: MoveStrategy = new CollectCoinsOnMap();

  decide(ctx: FightContext, memory: BulletMemory) {
    const arrived = ctx.myX === ctx.enemyBaseX && ctx.myY === ctx.enemyBaseY;
    const move = arrived ? "stay"
      : this.mover.step(ctx, ctx.enemyBaseX, ctx.enemyBaseY, memory);
    return { move, arrived };
  }
}

class Loot implements GoalStrategy {
  readonly name = "Loot";
  private mover: MoveStrategy = new CollectCoinsOnMap();

  decide(ctx: FightContext, memory: BulletMemory) {
    const target = nearestCoin(ctx);                 // implementation omitted
    const arrived = target === null;                 // no coins left = done
    const move = arrived ? "stay" : this.mover.step(ctx, target.x, target.y, memory);
    return { move, arrived };
  }
}
```

**Nested vs. flat — the one real design choice.** Should the *goal* pick the
mover (nested, above), or should the *agent* pick goal and mover independently
(flat, two axes on the agent)?

- **Nested**: clean encapsulation — each goal "knows how it likes to move". But
  every goal that wants to offer mover choice has to re-expose it, duplicating logic.
- **Flat**: all goal×mover combos free, no duplication, but the agent makes two
  decisions and some combos are nonsense (Retreat + CollectCoins = dawdling while fleeing).

Heuristic: if the mover is genuinely *a property of the goal* (Retreat should
basically always beeline), **nest**. If it's an independent tactical choice you'd
want under any goal, keep it **flat** as a second axis on the agent. For a
hackathon, flat is usually less code and the cross-combos are where the fun is.

---

## Multi-tick commitments (don't get interrupted mid-plan)

A retreat or a combo takes several ticks. The contract is one-decision-per-tick,
so "I'm mid-plan, don't reselect me" is expressed with the `arrived` boolean plus
a priority override — **not** by hardcoding "don't interrupt Retreat" in the agent
(that would couple the agent to one specific strategy).

Rule: **the agent keeps the current goal until it reports `arrived === true`,
except an emergency trigger can preempt it.** ("Never interrupt" gets you killed —
if you're calmly walking to base and about to die, you *want* to break off.) This
is exactly how a behavior-tree "running" node works.

```ts
private selectGoal(ctx: FightContext) {
  // 1. emergencies preempt even an unfinished goal
  if (ctx.hp < LOW_HP && this.goal.name !== "Retreat") {
    this.goal = this.goals.retreat;
    return;
  }
  // 2. otherwise, don't interrupt an unfinished commitment
  if (!this.lastArrived) return;

  // 3. finished -> pick the next goal normally
  this.goal = chooseNextGoal(ctx, this.goals);
}
```

---

## Agent memory member: `BulletMemory`

Remembers which enemies are already targeted so two shots don't both hit the same
enemy while a bullet is still in flight. `syncFromBullets` makes the map the
source of truth, so the memory self-corrects the instant a bullet resolves.

```ts
class BulletMemory {
  private claimed = new Map<string, number>(); // enemyId -> tick claimed

  claim(enemyId: string, tick: number) {
    this.claimed.set(enemyId, tick);
  }

  isClaimed(enemyId: string, now: number, cooldown: number): boolean {
    const at = this.claimed.get(enemyId);
    return at !== undefined && now - at <= cooldown;
  }

  release(enemyId: string) {
    this.claimed.delete(enemyId);
  }

  // reconcile against ground truth each tick
  syncFromBullets(bullets: Bullet[], now: number) {
    const live = new Set(bullets.map((b) => b.targetEnemyId));
    for (const id of [...this.claimed.keys()]) {
      if (!live.has(id)) this.release(id); // bullet landed/despawned -> re-targetable
    }
  }
}
```

---

## Implementation memory example: `FastestPath` (a mover)

The A* path is scratch state private to this instance. It recomputes only when an
*input* changes — map, target, or empty cache — then consumes one step per tick.
Disposable: swap away and back, and a fresh instance starts fresh (which is
correct — a stale saved path is a liability, not a saving).

```ts
class FastestPath implements MoveStrategy {
  readonly name = "FastestPath";

  // implementation memory — private to this instance
  private cachedPath: Move[] | null = null;
  private lastMapVersion = -1;
  private lastTargetX = -1;
  private lastTargetY = -1;

  step(ctx: FightContext, targetX: number, targetY: number, memory: BulletMemory): Move {
    const needsRecompute =
      this.cachedPath === null ||
      ctx.map.version !== this.lastMapVersion || // cheap version check, not a grid diff
      targetX !== this.lastTargetX ||
      targetY !== this.lastTargetY;

    if (needsRecompute) {
      this.cachedPath = runAStar(ctx, targetX, targetY); // the expensive call
      this.lastMapVersion = ctx.map.version;
      this.lastTargetX = targetX;
      this.lastTargetY = targetY;
    }

    return this.cachedPath.shift() ?? "stay";
  }
}
```

> **Invalidation rule:** recompute when *any input the computation depended on*
> changes. Comparing "did the map change" is only cheap if the map hands you a
> `version` integer / dirty flag — diffing the whole grid every tick just moves
> the cost, it doesn't remove it.

Other implementations exist with the same contracts (bodies omitted):

- `CollectCoinsOnMap implements MoveStrategy` — steps toward the target but detours through coins en route.
- `TargetClosestEnemy implements ShootStrategy` — nearest unclaimed enemy, then `memory.claim(...)`.
- `TargetClosestEnemyToBase implements ShootStrategy` — enemy nearest the base, then `memory.claim(...)`.

---

## The Agent

Holds the memory (once), holds the currently-active implementation of each layer
in a field, and is the only place that *selects*. `new` happens **once per
strategy at construction** — swaps are pure reference reassignment.

```ts
class CombatAgent {
  // ----- agent memory: created once, never replaced, survives every swap -----
  private bulletMemory = new BulletMemory();

  // ----- strategy instances: built once, reused (keeps their caches warm) -----
  private goals = {
    retreat: new Retreat(),
    attack: new Attack(),
    loot: new Loot(),
  };
  private shoots = {
    closest: new TargetClosestEnemy(10),
    base: new TargetClosestEnemyToBase(10),
  };

  // ----- current implementations (this IS "remember the current strategy") ----
  private goal: GoalStrategy = this.goals.loot;
  private shoot: ShootStrategy = this.shoots.closest;
  private lastArrived = true;

  private selectGoal(ctx: FightContext) {
    if (ctx.hp < LOW_HP && this.goal.name !== "Retreat") {
      this.goal = this.goals.retreat; // emergency preempts unfinished goals
      return;
    }
    if (!this.lastArrived) return;    // don't interrupt an unfinished commitment
    this.goal = chooseNextGoal(ctx, this.goals); // finished -> reselect
  }

  private selectShoot(ctx: FightContext) {
    const baseUnderThreat = ctx.enemies.some((e) => near(e, ctx.baseX, ctx.baseY));
    this.shoot = baseUnderThreat ? this.shoots.base : this.shoots.closest;
  }

  tick(ctx: FightContext): { move: Move; shot: Shot } {
    this.bulletMemory.syncFromBullets(ctx.bullets, ctx.now); // keep memory honest
    this.selectGoal(ctx);                                    // AGENT decides WHAT
    this.selectShoot(ctx);

    // SAME memory reference handed to every strategy
    const { move, arrived } = this.goal.decide(ctx, this.bulletMemory);
    const shot = this.shoot.decide(ctx, this.bulletMemory);

    this.lastArrived = arrived; // remember commitment progress for next tick
    return { move, shot };
  }

  currentStrategies() {
    return { goal: this.goal.name, shoot: this.shoot.name };
  }
}
```

---

## Flow of a single tick

```
game loop
   │
   ▼
agent.tick(ctx)                          ctx = context from the API
   │
   ├─ memory.syncFromBullets(...)        agent memory self-corrects vs. ground truth
   │
   ├─ selectGoal(ctx) / selectShoot(ctx) AGENT decides WHAT to run
   │      ├─ emergency? preempt even an unfinished goal
   │      ├─ mid-commitment (!arrived)? keep current goal
   │      └─ else reselect (just repoint fields — memory untouched)
   │
   ├─ goal.decide(ctx, memory)           GOAL strategy: WHERE + arrived?
   │      └─ mover.step(ctx, x, y, mem)    delegates HOW to a sub-strategy
   │            └─ uses its own A* cache (implementation memory)
   │
   └─ shoot.decide(ctx, memory)          SHOOT strategy: the actual shot
          └─ memory.claim(target)         writes agent memory — survives swaps
```

---

## Where does a new behavior go?

**This is the section to read when told to add a behavior mid-competition.**
Find the request shape, put the code in the named place. Do **not** invent a new
top-level system unless none of these fit.

| When you're told… | It's a… | Put it here |
|---|---|---|
| "Retreat when low HP" | new **goal** + a **selection rule** | new `GoalStrategy` (`Retreat`, destination = base) **and** an `if` in `selectGoal` that switches to it on the HP condition |
| "Attack the enemy base" | new **goal** | new `GoalStrategy`, destination = enemy base |
| "Grab coins while moving" | new **mover** | new `MoveStrategy` (`step` detours through coins); assign it as a goal's `mover`, or add it as a flat axis |
| "Path around walls better" | swap the **mover algorithm** | new `MoveStrategy` implementation; nothing else changes |
| "Shoot whoever's closest to our base" | new **shoot** | new `ShootStrategy`; add a branch in `selectShoot` |
| "Don't shoot the same enemy twice" | **shared bookkeeping** | it's **agent memory** → `BulletMemory` (or a new memory member); strategies call `claim`/`isClaimed` |
| "Don't interrupt a retreat" | a **commitment**, not a new strategy | rely on `arrived`; guard reselection with `if (!this.lastArrived) return` |
| "…but break off retreat if about to die" | an **emergency preempt** | an early `if` in `selectGoal` *above* the `!arrived` guard |
| "Cache X so we don't recompute every tick" | **implementation memory** | a private field on that strategy + an invalidation check (cheap version compare) |
| "Add a healer / shy / berserker unit type" | new **personality** | new `Personality` file (its own selection recipe pairing goal + action); register it so the controller can assign it |
| "Heal an ally / any new action" | new **action** | new `ActionStrategy` returning a new `GameAction` variant; add the variant to the tagged union in `core` |
| "Convert a unit's role mid-match" | controller **assignment** | call `agent.setPersonality(...)` in `TeamController`; ensure `onRoleChange` releases stale team claims |
| "Stop two of my bots hitting the same enemy" | **team memory** | `TargetClaims` on the `TeamController`, injected into every agent by reference |
| "Coordinate my bots / assign roles" | controller **logic** | `TeamController.tick` job 1 — keep it thin / scored (shared-edit hotspot) |
| "Move and act as one coordinated decision" | **coupled actions** | see *Coupled actions* section: name who decides first → ordered preview/commit pipeline in the personality; if truly circular → one joint strategy |

**Decision shortcuts:**

- Is it *where to go*? → `GoalStrategy`.
- Is it *how to step*? → `MoveStrategy`.
- Is it *whether/what to fire*? → `ShootStrategy`.
- Is it *when to switch behaviors*? → a rule in `selectGoal` / `selectShoot`, **not** a strategy.
- Is it *data to remember across swaps*? → **agent memory** member.
- Is it *scratch to avoid recompute*? → **implementation memory** field.

---

## Project layout & file management (2-person team)

The guiding principle: **one implementation = one file**, so two people can add
strategies in parallel and never touch the same file. Conflicts only happen in
*shared* files — this layout shrinks those to as few as possible and names them
so you know to coordinate before editing them.

```
src/
  core/
    types.ts            # Move, Shot, FightContext, Enemy, Coin, Bullet, GameMap
    contracts.ts        # GoalStrategy, MoveStrategy, ShootStrategy interfaces
                        #   ⚠ SHARED + STABLE — changing this ripples everywhere
  memory/
    BulletMemory.ts     # one file per memory member
    index.ts            # barrel: re-export memory members
  strategies/
    goal/
      Retreat.ts        # one file per implementation
      Attack.ts
      Loot.ts
      index.ts          # barrel: re-exports + the goal registry
    move/
      FastestPath.ts
      CollectCoinsOnMap.ts
      index.ts
    shoot/
      TargetClosestEnemy.ts
      TargetClosestEnemyToBase.ts
      index.ts
  agent/
    CombatAgent.ts      # ⚠ SHARED — holds tick() + selectGoal()/selectShoot()
    selection.ts        # (optional) selection rules pulled out of the agent
  util/
    pathfinding.ts      # runAStar, nearestCoin, near(), shared helpers
  main.ts               # wire up + game loop
```

**The two roles of `index.ts`** (the "index" and "definitions" split you asked about):

- `core/contracts.ts` + `core/types.ts` are the **definitions** — the contracts
  every implementation imports. Rarely change; when they do, everything downstream
  may need updating, so treat edits here as a "stop and sync with your teammate"
  event.
- Each folder's `index.ts` is the **barrel / registry** — it re-exports that
  folder's implementations and can expose a keyed registry the agent picks from:

```ts
// strategies/goal/index.ts
import { Retreat } from "./Retreat";
import { Attack } from "./Attack";
import { Loot } from "./Loot";

export { Retreat, Attack, Loot };

// registry the agent constructs once (keeps caches warm)
export const goalRegistry = () => ({
  retreat: new Retreat(),
  attack: new Attack(),
  loot: new Loot(),
});
```

An implementation file only imports *down* into `core` and `util`, never
sideways into a sibling implementation — that keeps each file independent and
addable in isolation.

### The conflict hotspots (know these before you split work)

Only three kinds of file are shared. Everything else is add-a-new-file, which
never conflicts:

1. **`core/contracts.ts`** — changing a contract touches every implementer.
   *Coordinate before editing.* Adding a new implementation should almost never
   require touching this.
2. **Each folder's `index.ts`** — every new implementation adds a line here, so
   two people adding strategies to the *same layer* at once will both edit the
   barrel. Mitigations: keep entries alphabetical (append conflicts become rare
   and trivial to resolve), or skip barrels entirely and import implementations
   directly where used.
3. **`agent/CombatAgent.ts` (specifically the selectors)** — this is the real
   one. Selection logic is genuinely shared brain, and both of you will want to
   add rules. Options: keep `selectGoal`/`selectShoot` thin and move rules into
   `selection.ts` as small named functions each person can add without colliding;
   or make selection itself a scoring system (each strategy exposes a `fit(ctx)`
   score, the agent picks the max) so adding a rule means editing *that strategy's
   file*, not the agent.

### A clean ownership split for two people

Because the layers are independent, split by **layer**, not by feature — then
your files barely overlap:

- **Person A: movement** — owns `strategies/goal/*`, `strategies/move/*`, `util/pathfinding.ts`.
- **Person B: combat** — owns `strategies/shoot/*`, `memory/*`.
- **Shared, edit-together:** `core/contracts.ts`, `agent/CombatAgent.ts`, `main.ts`.

Adding a strategy is then a pure new-file operation in your own folder + one
alphabetical line in your folder's barrel — zero chance of stepping on your
teammate. The only files you both touch are the three shared ones, and those
change rarely if the contracts are stable.

> **Rule of thumb for the doc's routing guide:** every "new strategy" row means
> *create a new file in the matching folder + add it to that folder's barrel*.
> Every "selection rule" row means *edit the shared agent/selection file* — the
> one place to slow down and check with your teammate.

---

## What if you control multiple agents?

Everything above is *one* bot. If you control a **team**, you add exactly one
layer on top — a **TeamController** — and one new memory tier. Nothing below the
controller changes in spirit; it's the same patterns applied one level up.

### The base `Agent` seam mirrors the game rules

The competition gives each unit **one move + one action per tick**, where the
action is a tagged type from the API (shoot, heal, …). So the base `Agent`
exposes exactly that and nothing more — the controller talks only to this seam
and never needs to know what kind of unit it's driving.

```ts
// mirror the API's action enum as a tagged union
type GameAction =
  | { kind: "shoot"; targetX: number; targetY: number }
  | { kind: "heal"; allyId: string }
  | { kind: "none" };

interface ActionStrategy {
  readonly name: string;
  decide(ctx: FightContext, team: TeamMemory): GameAction;
}

// one agent class for everyone — walk + doAction, exactly like the rules
class Agent {
  private goal: GoalStrategy;          // where to walk
  private action: ActionStrategy;      // what to do (shoot/heal/none)
  private personality: Personality;    // <-- swappable selection policy
  private lastArrived = true;

  setPersonality(p: Personality) {     // memory + position survive the swap
    this.personality = p;
    this.onRoleChange();
  }

  tick(ctx: FightContext, team: TeamMemory): { walk: Move; action: GameAction } {
    this.personality.select(this, ctx, this.lastArrived); // repoint goal/action fields
    const { move, arrived } = this.goal.decide(ctx, team);
    const action = this.action.decide(ctx, team);
    this.lastArrived = arrived;
    return { walk: move, action };
  }
}
```

Because heal is just another `GameAction` variant, a healer needs **no** special
agent type and **no** extra action slot — the base seam is unchanged. That's the
API resolving the "is heal a third action?" fork for us.

### Personality is a *selection strategy*, chosen by composition — not a subclass

A personality owns **no** moves or actions of its own. It owns the *policy for
choosing and pairing them across ticks* — the `selectGoal`/`selectAction` logic
we've been threading all along, now packaged as a swappable object:

```ts
interface Personality {
  readonly name: string;
  select(agent: Agent, ctx: FightContext, arrived: boolean): void; // repoints agent's fields
}
```

Why composition and **not** `class HealerAgent extends Agent`: personality can
**change mid-match** (a warrior is reassigned to healer when the healer dies).
Inheritance would force constructing a *new object* to change behavior — throwing
away that agent's memory and position, the exact thing this whole design exists
to prevent. As a swappable field, `setPersonality` changes behavior while memory
and position **survive**. (This is the recursion we already flagged: "make the
selector itself a strategy.")

A personality is a **matched set of choices across every layer** — that's what
earns each one its own file. The healer proves it: its two halves are coordinated
and sequenced through `arrived`.

```ts
// personalities/HealerPersonality.ts
class HealerPersonality implements Personality {
  readonly name = "Healer";
  select(agent: Agent, ctx: FightContext, arrived: boolean) {
    agent.setGoal(new MoveTowardsAlly());   // WHERE: get near a wounded ally
    // sequence the action off the goal's `arrived` signal:
    agent.setAction(arrived ? new HealClosestAlly() : NO_ACTION);
  }
}

// personalities/WarriorPersonality.ts — a totally different pairing
class WarriorPersonality implements Personality {
  readonly name = "Warrior";
  select(agent: Agent, ctx: FightContext, arrived: boolean) {
    agent.setGoal(ctx.hp < LOW_HP ? new Retreat() : new Attack());
    agent.setAction(new TargetClosestEnemy(10));
  }
}
```

The strategies themselves (`MoveTowardsAlly`, `HealClosestAlly`, `Retreat`, …)
stay **shared** in the strategy folders — anyone can add them. Only the *recipe*
that assembles them is personality-specific. So the two-person split extends
naturally: **you own `HealerPersonality.ts`, your teammate owns
`WarriorPersonality.ts`**, both drawing from the same shared strategy pool.

### The third memory tier: team memory

Apply the doc's own test one level higher — *"if this agent dies, should this be
forgotten?"* No → it's **team memory**, owned by the controller and injected (by
reference, same trick) into every agent:

```
implementation memory   (per strategy instance — e.g. A* cache)
  ⊂  agent memory        (per agent — its own scratch, survives personality swap)
  ⊂  team memory         (per controller — shared claim board, survives an agent's death)
```

`TargetClaims` (the "one shot per enemy" board) is now **team** memory: when any
bot claims enemy_3, every other bot sees it instantly. That's "one stop, no
double-hits" across the whole team.

### The controller: the new god-class

```ts
class TeamController {
  private team = new TeamMemory();     // team tier, created once
  private agents: Agent[];

  tick(ctx: WorldContext) {
    // job 1: read the global context, assign roles/personalities
    if (noHealerAlive(this.agents)) {
      const recruit = healthiestWarrior(this.agents);
      recruit?.setPersonality(new HealerPersonality()); // warrior -> healer, memory intact
    }

    // job 2: run every agent against the SHARED team memory
    return this.agents.map((a) => a.tick(ctx, this.team));
  }
}
```

**The conversion hook (`onRoleChange`) — don't skip it.** When a warrior becomes
a healer, it stops shooting — so anything it claimed in team memory must be
**released**, or teammates will keep avoiding an enemy nobody is covering:

```ts
private onRoleChange() {
  this.team.releaseAllClaimsBy(this.id); // free targets the old role reserved
}
```

Two cautions, both familiar. The controller is the **new shared-edit hotspot**
(like `CombatAgent` was for one bot) — keep role-assignment thin, or make it a
small scored decision, so both of you can add rules without colliding. And keep
**"personality" (a disposition) vs "role" (an assigned job)** straight: if the
controller assigns jobs *and* personality is a separate trait, you have two
knobs, not one — decide explicitly whether they're the same thing.

---

## Coupled actions: when you actually need it

Default: `walk` and `doAction` are decided independently. When a behavior needs
them to depend on each other, **coupling has a direction**, and the direction
tells you the mechanism. Find your case first:

| Case | Direction | Example | Mechanism |
|---|---|---|---|
| 1 | **move → action** | healer: get in range, *then* heal if `arrived` | ordered pipeline, move first |
| 2 | **action → move** | kiter: pick the target, *then* flee away from *it* | ordered pipeline, action first |
| 3 | **bidirectional** | peek-and-shoot: only step out *if* I'll have a shot | preview both, then commit — or joint strategy |

You already built **case 1** (the healer's `arrived` handoff). Cases 1 and 2 are
the same tool in opposite orders; case 3 needs one more idea.

### The mechanism: a tick-lifetime plan + pure preview / commit

Two pieces. First, a **`TickPlan`** — an ephemeral scratchpad created fresh each
tick and **never persisted** (stale intent leaking across ticks is a bug). It's a
memory tier *shorter*-lived than implementation memory.

```ts
interface TickPlan {
  focusEnemyId?: string;                       // action tells move what it engages
  intendedNextPos?: { x: number; y: number };  // move tells action where we'll be
  arrived?: boolean;                           // goal tells action it's in range
}
```

Second — and this is the one law that makes it safe — **preview must be pure.**
Split "compute a candidate" (no side effects) from "commit it" (side effects):

```ts
interface ActionStrategy {
  preview(ctx: FightContext, plan: TickPlan): GameAction;  // PURE — no team-memory writes
  commit(chosen: GameAction, team: TeamMemory): void;      // side effects live ONLY here
}
```

Why the law matters: if `preview` called `team.claim(enemy_3)`, then merely
*asking* "what would you do?" would reserve the target — and if you then discard
that candidate, the claim leaks and teammates avoid an enemy nobody is engaging. A
preview that mutates shared state is a commitment in disguise.

> **"Pure" means no *semantically observable* side effect — it does NOT forbid
> caching.** `preview` may run A* and stash the path in *its own* implementation
> memory; `commit` consumes it. Mutating your **private scratch** = fine in
> preview. Mutating **shared/team memory** = commit only. That line is the whole
> art of it — and it means you never pay the A* cost twice.

### The personality orchestrates the order (it already owns pairing)

Ordering can't live in a fixed `tick()`, because case 1 and case 2 need opposite
orders. The personality already knows both halves, so it owns sequencing too:

```ts
// KiterPersonality — case 2, action decides first
decide(agent, ctx, team) {
  const plan: TickPlan = {};
  const action = agent.action.preview(ctx, plan); // sets plan.focusEnemyId
  const move = agent.goal.preview(ctx, plan);     // KiteAway reads focusEnemyId
  agent.action.commit(action, team);              // side effects now
  return { walk: move.move, action };
}

// PeekShooter — case 3, preview BOTH then decide, commit only if kept
decide(agent, ctx, team) {
  const move = agent.goal.preview(ctx, {});                       // where would I step?
  const shot = agent.action.preview(ctx, { intendedNextPos: move.pos }); // shot from there?

  if (shot.kind === "none") {
    return { walk: "stay", action: { kind: "none" } };            // no shot -> stay, commit nothing
  }
  agent.action.commit(shot, team);                                // good pair -> commit
  return { walk: move.move, action: shot };
}
```

The strategies stay reusable — `KiteAway`, `TargetClosestEnemy` don't know they're
coupled; they only read/write the plan if it's handed to them. `plan` is optional,
so the uncoupled 90% ignore it and keep plain `decide` — no contract pollution.

### The escape hatch: genuine circularity → one joint strategy

Preview-both still previews against a *guess* of the other side. Almost always
fine (one side can preview against *current* state). But if move needs the
*committed* action and action needs the *committed* move at the same instant —
true circularity — stop splitting: collapse **that one tactic** into a single
joint strategy that returns `{ walk, action }` decided together.

```ts
class PeekAndShoot implements JointTactic {
  decide(ctx, team): { walk: Move; action: GameAction } {
    const cover = findShotWithoutMoving(ctx);
    if (cover) return { walk: "stay", action: cover };
    const peek = bestPeekWithShot(ctx);            // both computed jointly, consistent
    return peek
      ? { walk: stepToward(ctx, peek.pos), action: peek.shot }
      : { walk: retreatToCover(ctx), action: { kind: "none" } };
  }
}
```

You merge **only the coupled tactic**, not the architecture — warriors, healers,
kiters keep the split; the one peek-shoot personality holds a joint tactic instead
of a goal+action pair. Modularity is lost only for the behavior that genuinely
can't be modular, which is correct, not a compromise.

### The decision rule

> **Can I name who decides first?**
> Yes → **ordered pipeline** (preview the first, feed its plan to the second, commit).
> No → **joint strategy** (one object decides both together).

(There's a heavier option — every layer proposes *scored* candidates and a
resolver picks the jointly-best pair — but it's a mini-search over the pair space.
Overkill for a hackathon; reach for it only if joint-strategy duplication starts
hurting across many bidirectional tactics.)

---

## Known limits

This is a **reactive, modular** design. Even with the team and coupling layers
added, it still resists one thing (team state and coupled actions are now handled
above):

1. **Lookahead / planning.** Every tick picks locally; nothing searches over the
   whole match. If the winning meta is "simulate a few moves ahead" (MCTS-style),
   this pattern survives only as the leaf evaluator inside a search, not as the
   top-level brain. (This applies to the controller too — role assignment is
   greedy, not a planned formation.)

*Team state used to be a limit — it's now handled by the TeamController + team
memory tier above.*

The useful question for the specific game: **is winning about reacting well, or
about predicting/planning better than the other bots?** Reacting → this is enough.
Planning → keep this for the tactical layer and put a search loop on top.

Smaller notes: `selectGoal`/`selectShoot` are hardcoded `if`/`else`; if selection
logic gets serious, make the *selector itself* a strategy or a scoring system
(each candidate returns a "how well do I fit right now" score, agent picks the max).

---

## Summary

The three memory tiers, by lifetime (each survives more than the one above it):

| | Implementation memory | Agent memory | Team memory |
|---|---|---|---|
| Lives on | a strategy instance | the agent | the controller |
| Holds | that algorithm's private scratch (incl. its sub-strategy) | facts the agent knows / its current strategies | shared truth across the whole team |
| Survives strategy swap? | **No** (disposable) | **Yes** | **Yes** |
| Survives personality swap? | No | **Yes** (position + knowledge kept) | **Yes** |
| Survives an agent's death? | No | No | **Yes** |
| Example | `FastestPath`'s A* cache | that bot's own scratch | `TargetClaims` board |
| Reason it exists | avoid recomputing every tick | per-bot state across swaps | no double-hits across bots |

The tier test, applied at each boundary: **"if I swap the strategy / swap the
personality / lose the agent — should this be forgotten?"** First *yes* names the
tier it belongs to.

**Rules of thumb**

- The **agent decides which strategy**; the **strategy makes the actual decision**; the **controller decides which personality**.
- Layers: **goal** = where, **mover** = how, **action** = shoot/heal/none. `arrived` lives on the goal.
- `new` a strategy **only when the strategy changes** — otherwise reassign references.
- **Personality = a selection strategy** (composition, swappable field), never a subclass — so memory survives reassignment.
- Want state to survive a swap? **agent memory**. Survive an agent's death? **team memory**.
- Strategies edit memory **through methods** (by reference), never by reassigning it.
- Thread shared memory (agent *and* team) through every nested layer that needs it; keep impl-memory internal.
- Don't interrupt a commitment (`!arrived`) except for an **emergency** preempt.
- On role conversion, **release the old role's team claims** (`onRoleChange`).
- Coupled actions: name who decides first → **ordered preview/commit** in the personality; **preview is pure** (no team-memory writes), commit does side effects; truly circular → **one joint strategy**.

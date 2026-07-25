// ============================== //
//                                //
//  NE PAS MODIFIER CE FICHIER    //
//   DO NOT MODIFY THIS FILE      //
//                                //
// ============================== //

type ServerData = Record<string, unknown>;

function getValue<T>(data: ServerData | undefined | null, key: string, fallback: T): T {
  if (!data || data[key] === undefined || data[key] === null) {
    return fallback;
  }

  return data[key] as T;
}

function asRecord(value: unknown): ServerData {
  return value && typeof value === "object" ? (value as ServerData) : {};
}

function asArray(value: unknown): ServerData[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function asNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map((item) => asNumber(item)) : [];
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function positionFrom(value: unknown): Position {
  const data = asRecord(value);
  return new Position(asNumber(data.x), asNumber(data.y));
}

function inventoryFrom(value: unknown): ItemStack[] {
  return asArray(value).map(
    (item) => new ItemStack(String(getValue(item, "itemName", "unknown")), asNumber(item.quantity)),
  );
}

function positionPayload(position: Position): { x: number; y: number } {
  return { x: position.X, y: position.Y };
}

function tileKey(position: Position): string {
  return `${position.X},${position.Y}`;
}

export class Position {
  public constructor(
    public readonly X: number,
    public readonly Y: number,
  ) {}
}

export class Tile {
  public constructor(
    public readonly Position: Position,
    public readonly Terrain: string,
    public readonly TerrainCategory: string,
    public readonly Zone: string,
    public readonly ZoneOwnerTeamId: number | null,
    public readonly HasStructure: boolean,
    public readonly HasEntity: boolean,
    public readonly HasResource: boolean,
  ) {}

  public static fromServer(data: ServerData): Tile {
    const position = new Position(asNumber(data.x), asNumber(data.y));
    const owner = getValue<unknown>(data, "zoneOwnerTeamId", null);

    return new Tile(
      position,
      String(getValue(data, "terrain", "Empty")),
      String(getValue(data, "terrainCategory", "Land")),
      String(getValue(data, "zone", "WarZone")),
      owner === null ? null : asNumber(owner),
      asBoolean(data.hasStructure),
      asBoolean(data.hasEntity),
      asBoolean(data.hasResource),
    );
  }
}

export class ItemStack {
  public constructor(
    public readonly ItemName: string,
    public readonly Quantity: number,
  ) {}
}

export class Resource {
  public Id = 0;
  public Name = "";
  public LootItem = "";
  public Description = "";
  public Position = new Position(0, 0);
  public CurrentAmount = 0;
  public Capacity = 0;
  public RemainingTicks = 0;
  public CanHostExtractor = false;
  public CanHostPump = false;

  public static fromServer(data: ServerData): Resource {
    const resource = new Resource();
    resource.Id = asNumber(data.id);
    resource.Name = String(getValue(data, "name", "unknown"));
    resource.LootItem = String(getValue(data, "lootItem", ""));
    resource.Description = String(getValue(data, "description", ""));
    resource.Position = positionFrom(data.position);
    resource.CurrentAmount = asNumber(data.currentAmount);
    resource.Capacity = asNumber(data.capacity);
    resource.RemainingTicks = asNumber(data.remainingTicks);
    resource.CanHostExtractor = asBoolean(data.canHostExtractor);
    resource.CanHostPump = asBoolean(data.canHostPump);
    return resource;
  }
}

export class PlayerInfo {
  public Id = 0;
  public TeamId = 0;
  public BotType = "BotA";
  public Health = 0;
  public MaxHealth = 0;
  public Shield = 0;
  public MaxShield = 0;
  public Position = new Position(0, 0);
  public Inventory: ItemStack[] = [];
  public Slots = 0;

  public static fromServer(data: ServerData): PlayerInfo {
    const player = new PlayerInfo();
    player.Id = asNumber(data.id);
    player.TeamId = asNumber(data.teamId);
    player.BotType = String(getValue(data, "botType", "BotA"));
    player.Health = asNumber(data.health);
    player.MaxHealth = asNumber(data.maxHealth);
    player.Shield = asNumber(data.shield);
    player.MaxShield = asNumber(data.maxShield);
    player.Position = positionFrom(data.position);
    player.Inventory = inventoryFrom(data.inventory);
    player.Slots = asNumber(data.slots);
    return player;
  }
}

export class VisiblePlayer {
  public PlayerId = 0;
  public TeamId = 0;
  public BotType: string | null = null;
  public IsAlly = false;
  public IsSelf = false;
  public PvpActivated = false;
  public Alive = true;
  public RespawnRemainingTicks = 0;
  public Position = new Position(0, 0);
  public Health = 0;
  public MaxHealth = 0;
  public Shield = 0;
  public MaxShield = 0;
  public Slots = 0;
  public Inventory: ItemStack[] = [];

  public static fromServer(data: ServerData): VisiblePlayer {
    const player = new VisiblePlayer();
    player.PlayerId = asNumber(getValue(data, "playerId", data.id ?? 0));
    player.TeamId = asNumber(data.teamId);
    player.BotType = getValue<unknown>(data, "botType", null) === null ? null : String(data.botType);
    player.IsAlly = asBoolean(data.isAlly);
    player.IsSelf = asBoolean(data.isSelf);
    player.PvpActivated = asBoolean(data.pvpActivated);
    player.Alive = asBoolean(data.alive, true);
    player.RespawnRemainingTicks = asNumber(data.respawnRemainingTicks);
    player.Position = positionFrom(data.position);
    player.Health = asNumber(data.health);
    player.MaxHealth = asNumber(data.maxHealth);
    player.Shield = asNumber(data.shield);
    player.MaxShield = asNumber(data.maxShield);
    player.Slots = asNumber(data.slots);
    player.Inventory = inventoryFrom(data.inventory);
    return player;
  }
}

export class VisibleCompanion {
  public CompanionId = 0;
  public TeamId = 0;
  public OwnerPlayerId = 0;
  public IsAlly = false;
  public PvpActivated = false;
  public Position = new Position(0, 0);
  public Health = 0;
  public MaxHealth = 0;
  public InventoryItemsCount = 0;

  public static fromServer(data: ServerData): VisibleCompanion {
    const companion = new VisibleCompanion();
    companion.CompanionId = asNumber(data.companionId);
    companion.TeamId = asNumber(data.teamId);
    companion.OwnerPlayerId = asNumber(data.ownerPlayerId);
    companion.IsAlly = asBoolean(data.isAlly);
    companion.PvpActivated = asBoolean(data.pvpActivated);
    companion.Position = positionFrom(data.position);
    companion.Health = asNumber(data.health);
    companion.MaxHealth = asNumber(data.maxHealth);
    companion.InventoryItemsCount = asNumber(data.inventoryItemsCount);
    return companion;
  }
}

export class VisibleStructure {
  public Id = 0;
  public Type = "Extractor";
  public OwnerTeamId = 0;
  public OwnerBaseId = 0;
  public IsAlly = false;
  public PvpActivated = false;
  public Position = new Position(0, 0);
  public Width = 1;
  public Height = 1;
  public Hp = 0;
  public MaxHp = 0;
  public PowerOn = false;
  public IsActive = false;
  public VisionRadius = 0;

  public static fromServer(data: ServerData): VisibleStructure {
    const structure = new VisibleStructure();
    structure.Id = asNumber(data.id);
    structure.Type = String(getValue(data, "type", "Extractor"));
    structure.OwnerTeamId = asNumber(data.ownerTeamId);
    structure.OwnerBaseId = asNumber(data.ownerBaseId);
    structure.IsAlly = asBoolean(data.isAlly);
    structure.PvpActivated = asBoolean(data.pvpActivated);
    structure.Position = positionFrom(data.position);
    structure.Width = asNumber(data.width, 1);
    structure.Height = asNumber(data.height, 1);
    structure.Hp = asNumber(data.hp);
    structure.MaxHp = asNumber(data.maxHp);
    structure.PowerOn = asBoolean(data.powerOn);
    structure.IsActive = asBoolean(data.isActive);
    structure.VisionRadius = asNumber(data.visionRadius);
    return structure;
  }
}

export class ResearchJobInfo {
  public Id = 0;
  public ResearchId = "";
  public TotalTicks = 0;
  public RemainingTicks = 0;

  public static fromServer(data: ServerData): ResearchJobInfo {
    const job = new ResearchJobInfo();
    job.Id = asNumber(data.id);
    job.ResearchId = String(getValue(data, "researchId", ""));
    job.TotalTicks = asNumber(data.totalTicks);
    job.RemainingTicks = asNumber(data.remainingTicks);
    return job;
  }
}

export class BadgeInfo {
  public Id = "";
  public Name = "";
  public Description = "";
  public Category = "";
  public MetricType = "";
  public Hidden = false;
  public Unlocked = false;
  public Progress = 0;
  public NextTarget = 0;

  public static fromServer(data: ServerData): BadgeInfo {
    const badge = new BadgeInfo();
    badge.Id = String(getValue(data, "id", ""));
    badge.Name = String(getValue(data, "name", ""));
    badge.Description = String(getValue(data, "description", ""));
    badge.Category = String(getValue(data, "category", ""));
    badge.MetricType = String(getValue(data, "metricType", ""));
    badge.Hidden = asBoolean(data.hidden);
    badge.Unlocked = asBoolean(data.unlocked);
    badge.Progress = asNumber(data.progress);
    badge.NextTarget = asNumber(data.nextTarget);
    return badge;
  }
}

export class ProcessingJobInfo {
  public Id = 0;
  public RecipeId = "";
  public TotalTicks = 0;
  public RemainingTicks = 0;
  public InputsPaid = false;
  public RequestedRuns: number | null = null;
  public CompletedRuns = 0;
  public Repeat = false;

  public static fromServer(data: ServerData): ProcessingJobInfo {
    const job = new ProcessingJobInfo();
    job.Id = asNumber(data.id);
    job.RecipeId = String(getValue(data, "recipeId", ""));
    job.TotalTicks = asNumber(data.totalTicks);
    job.RemainingTicks = asNumber(data.remainingTicks);
    job.InputsPaid = asBoolean(data.inputsPaid);
    job.RequestedRuns = data.requestedRuns === undefined || data.requestedRuns === null ? null : asNumber(data.requestedRuns);
    job.CompletedRuns = asNumber(data.completedRuns);
    job.Repeat = asBoolean(data.repeat);
    return job;
  }
}

export class GeneratorJobInfo {
  public Id = 0;
  public ItemName = "";
  public TotalTicks = 0;
  public RemainingTicks = 0;
  public ItemPaid = false;
  public Repeat = false;
  public WaitingForItem = false;

  public static fromServer(data: ServerData): GeneratorJobInfo {
    const job = new GeneratorJobInfo();
    job.Id = asNumber(data.id);
    job.ItemName = String(getValue(data, "itemName", ""));
    job.TotalTicks = asNumber(data.totalTicks);
    job.RemainingTicks = asNumber(data.remainingTicks);
    job.ItemPaid = asBoolean(data.itemPaid);
    job.Repeat = asBoolean(data.repeat);
    job.WaitingForItem = asBoolean(data.waitingForItem);
    return job;
  }
}

export class MuseumPedestalInfo {
  public SlotIndex = 0;
  public ItemName: string | null = null;
  public Quantity = 0;
  public ValueBonus = 0;
  public MaxValueBonus = 0;

  public static fromServer(data: ServerData): MuseumPedestalInfo {
    const pedestal = new MuseumPedestalInfo();
    pedestal.SlotIndex = asNumber(data.slotIndex);
    pedestal.ItemName = data.itemName === undefined || data.itemName === null ? null : String(data.itemName);
    pedestal.Quantity = asNumber(data.quantity);
    pedestal.ValueBonus = asNumber(data.valueBonus);
    pedestal.MaxValueBonus = asNumber(data.maxValueBonus);
    return pedestal;
  }
}

export class InternalStructureInfo {
  public Type = "";
  public Locked = false;
  public MaxQueueSlots = 0;
  public MuseumSlots = 0;
  public MuseumBonusPerItem = 0;
  public MuseumMaxBonusPerItem = 0;
  public Queue: ProcessingJobInfo[] = [];
  public GeneratorQueue: GeneratorJobInfo[] = [];
  public Pedestals: MuseumPedestalInfo[] = [];

  public static fromServer(data: ServerData): InternalStructureInfo {
    const structure = new InternalStructureInfo();
    structure.Type = String(getValue(data, "type", ""));
    structure.Locked = asBoolean(data.locked);
    structure.MaxQueueSlots = asNumber(data.maxQueueSlots);
    structure.MuseumSlots = asNumber(data.museumSlots);
    structure.MuseumBonusPerItem = asNumber(data.museumBonusPerItem);
    structure.MuseumMaxBonusPerItem = asNumber(data.museumMaxBonusPerItem);
    structure.Queue = asArray(data.queue).map(ProcessingJobInfo.fromServer);
    structure.GeneratorQueue = asArray(data.generatorQueue).map(GeneratorJobInfo.fromServer);
    structure.Pedestals = asArray(data.pedestals).map(MuseumPedestalInfo.fromServer);
    return structure;
  }
}

export class QuestStateInfo {
  public SlotIndex = 0;
  public InstanceId = "";
  public TemplateId = "";
  public Name = "";
  public Description = "";
  public Type = "";
  public MetricType = "";
  public SubjectName = "";
  public Progress = 0;
  public Target = 0;
  public Status = "";
  public BaseReward = 0;
  public Reward = 0;
  public ResetAt: number | null = null;
  public RemainingResetSeconds = 0;

  public static fromServer(data: ServerData): QuestStateInfo {
    const quest = new QuestStateInfo();
    quest.SlotIndex = asNumber(data.slotIndex);
    quest.InstanceId = String(getValue(data, "instanceId", ""));
    quest.TemplateId = String(getValue(data, "templateId", ""));
    quest.Name = String(getValue(data, "name", ""));
    quest.Description = String(getValue(data, "description", ""));
    quest.Type = String(getValue(data, "type", ""));
    quest.MetricType = String(getValue(data, "metricType", ""));
    quest.SubjectName = String(getValue(data, "subjectName", ""));
    quest.Progress = asNumber(data.progress);
    quest.Target = asNumber(data.target);
    quest.Status = String(getValue(data, "status", ""));
    quest.BaseReward = asNumber(data.baseReward);
    quest.Reward = asNumber(data.reward);
    quest.ResetAt = data.resetAt === undefined || data.resetAt === null ? null : asNumber(data.resetAt);
    quest.RemainingResetSeconds = asNumber(data.remainingResetSeconds);
    return quest;
  }
}

export class TeamInfo {
  public Id = 0;
  public Name = "";
  public Score = 0;
  public LaboratoryLevel = 0;
  public LaboratoryQueuesNumber = 0;
  public LaboratoryProductionSpeed = 0;
  public GeneratorProductionSpeed = 0;
  public GeneratorScoreMultiplier = 0;
  public MuseumSlots = 0;
  public MuseumBonusPerItem = 0;
  public MuseumMaxBonusPerItem = 20;
  public CraftAutomaticCycle = false;
  public PvpActivated = false;
  public NumberOfExtractor = 0;
  public NumberOfPump = 0;
  public NumberOfRadar = 0;
  public CompanionNumber = 0;
  public CompanionMaxHp = 100;
  public CompanionSlots = 6;
  public CompletedResearchIds: string[] = [];
  public ResearchQueue: ResearchJobInfo[] = [];
  public QuestSlots = 0;
  public QuestTimerReset = 0;
  public BonusQuestComplete = 1;
  public QuestQueue: QuestStateInfo[] = [];
  public Badges: BadgeInfo[] = [];

  public static fromServer(data: ServerData): TeamInfo {
    const team = new TeamInfo();
    team.Id = asNumber(data.id);
    team.Name = String(getValue(data, "name", ""));
    team.Score = asNumber(data.score);
    team.LaboratoryLevel = asNumber(data.laboratoryLevel);
    team.LaboratoryQueuesNumber = asNumber(data.laboratoryQueuesNumber);
    team.LaboratoryProductionSpeed = asNumber(data.laboratoryProductionSpeed);
    team.GeneratorProductionSpeed = asNumber(data.generatorProductionSpeed);
    team.GeneratorScoreMultiplier = asNumber(data.generatorScoreMultiplier);
    team.MuseumSlots = asNumber(data.museumSlots);
    team.MuseumBonusPerItem = asNumber(data.museumBonusPerItem, 0.01);
    team.MuseumMaxBonusPerItem = asNumber(data.museumMaxBonusPerItem, 20);
    team.CraftAutomaticCycle = asBoolean(data.craftAutomaticCycle);
    team.PvpActivated = asBoolean(data.pvpActivated);
    team.NumberOfExtractor = asNumber(data.numberOfExtractor);
    team.NumberOfPump = asNumber(data.numberOfPump);
    team.NumberOfRadar = asNumber(data.numberOfRadar);
    team.CompanionNumber = asNumber(data.companionNumber);
    team.CompanionMaxHp = asNumber(data.companionMaxHp, 100);
    team.CompanionSlots = asNumber(data.companionSlots, 6);
    team.CompletedResearchIds = asStringArray(data.completedResearchIds);
    team.ResearchQueue = asArray(data.researchQueue).map(ResearchJobInfo.fromServer);
    team.QuestSlots = asNumber(data.questSlots);
    team.QuestTimerReset = asNumber(data.questTimerReset);
    team.BonusQuestComplete = asNumber(data.bonusQuestComplete, 1);
    team.QuestQueue = asArray(data.questQueue).map(QuestStateInfo.fromServer);
    team.Badges = asArray(data.badges).map(BadgeInfo.fromServer);
    return team;
  }
}

export class BaseInfo {
  public Id = 0;
  public Position = new Position(0, 0);
  public Width = 0;
  public Height = 0;
  public StorageSlots = 0;
  public Inventory: ItemStack[] = [];
  public InternalStructures: InternalStructureInfo[] = [];

  public static fromServer(data: ServerData): BaseInfo {
    const base = new BaseInfo();
    base.Id = asNumber(data.id);
    base.Position = positionFrom(data.position);
    base.Width = asNumber(data.width);
    base.Height = asNumber(data.height);
    base.StorageSlots = asNumber(data.storageSlots);
    base.Inventory = inventoryFrom(data.inventory);
    base.InternalStructures = asArray(data.internalStructures).map(InternalStructureInfo.fromServer);
    return base;
  }
}

export class GameState {
  public CurrentTick = 0;
  public VisibleTiles = new Map<string, Tile>();
  public VisibleResources: Resource[] = [];
  public VisiblePlayers: VisiblePlayer[] = [];
  public VisibleCompanions: VisibleCompanion[] = [];
  public VisibleStructures: VisibleStructure[] = [];
  public TeamPlayers: VisiblePlayer[] = [];
  public Bot: PlayerInfo | null = null;
  public Team: TeamInfo | null = null;
  public Base: BaseInfo | null = null;

  public updatePlayer(data: ServerData): void {
    this.Bot = PlayerInfo.fromServer(data);
  }

  public updateVisionFromServer(data: ServerData): void {
    if (asBoolean(getValue(data, "isComplete", true), true)) {
      this.updateVision(data);
      return;
    }

    this.updatePartialVision(data);
  }

  public updateVision(data: ServerData): void {
    this.updateTiles(data);
    this.updateTeam(data);
    this.updatePlayers(data);
    this.updateCompanions(data);
    this.updateResources(data);
    this.updateStructures(data);
  }

  public updatePartialVision(data: ServerData): void {
    this.updateTeam(data);
    this.updateTilesDelta(data);
    this.updatePlayersDelta(data);
    this.updateCompanionsDelta(data);
    this.updateResourcesDelta(data);
    this.updateStructuresDelta(data);
  }

  public getTileAt(pos: Position): Tile | undefined {
    return this.VisibleTiles.get(tileKey(pos));
  }

  private updateTiles(data: ServerData): void {
    this.VisibleTiles.clear();
    for (const tile of asArray(data.tiles)) {
      const parsed = Tile.fromServer(tile);
      this.VisibleTiles.set(tileKey(parsed.Position), parsed);
    }
  }

  private updateTilesDelta(data: ServerData): void {
    for (const tile of asArray(data.updatedTiles)) {
      const parsed = Tile.fromServer(tile);
      this.VisibleTiles.set(tileKey(parsed.Position), parsed);
    }

    for (const position of asArray(data.removedTiles)) {
      const pos = positionFrom(position);
      this.VisibleTiles.delete(tileKey(pos));
    }
  }

  private updateTeam(data: ServerData): void {
    if (data.team !== undefined && data.team !== null) {
      this.Team = TeamInfo.fromServer(asRecord(data.team));
    }

    if (data.base !== undefined && data.base !== null) {
      this.Base = BaseInfo.fromServer(asRecord(data.base));
    }
  }

  private updatePlayers(data: ServerData): void {
    this.TeamPlayers = asArray(data.teamPlayers).map(VisiblePlayer.fromServer);
    this.VisiblePlayers = asArray(data.visiblePlayers).map(VisiblePlayer.fromServer);
  }

  private updatePlayersDelta(data: ServerData): void {
    if (data.teamPlayers !== undefined) {
      this.TeamPlayers = asArray(data.teamPlayers).map(VisiblePlayer.fromServer);
    }

    const removed = new Set(asNumberArray(data.removedPlayerIds));
    this.VisiblePlayers = this.VisiblePlayers.filter((player) => !removed.has(player.PlayerId));

    for (const player of asArray(data.updatedPlayers)) {
      const parsed = VisiblePlayer.fromServer(player);
      this.VisiblePlayers = this.VisiblePlayers.filter((existing) => existing.PlayerId !== parsed.PlayerId);
      this.VisiblePlayers.push(parsed);
    }
  }

  private updateCompanions(data: ServerData): void {
    this.VisibleCompanions = asArray(data.visibleCompanions).map(VisibleCompanion.fromServer);
  }

  private updateCompanionsDelta(data: ServerData): void {
    const removed = new Set(asNumberArray(data.removedCompanionIds));
    this.VisibleCompanions = this.VisibleCompanions.filter((companion) => !removed.has(companion.CompanionId));

    for (const companion of asArray(data.updatedCompanions)) {
      const parsed = VisibleCompanion.fromServer(companion);
      this.VisibleCompanions = this.VisibleCompanions.filter((existing) => existing.CompanionId !== parsed.CompanionId);
      this.VisibleCompanions.push(parsed);
    }
  }

  private updateResources(data: ServerData): void {
    this.VisibleResources = asArray(data.resources).map(Resource.fromServer);
  }

  private updateResourcesDelta(data: ServerData): void {
    const removed = new Set(asNumberArray(data.removedResourceIds));
    this.VisibleResources = this.VisibleResources.filter((resource) => !removed.has(resource.Id));

    for (const resource of asArray(data.updatedResources)) {
      const parsed = Resource.fromServer(resource);
      this.VisibleResources = this.VisibleResources.filter((existing) => existing.Id !== parsed.Id);
      this.VisibleResources.push(parsed);
    }
  }

  private updateStructures(data: ServerData): void {
    this.VisibleStructures = asArray(data.visibleStructures).map(VisibleStructure.fromServer);
  }

  private updateStructuresDelta(data: ServerData): void {
    const removed = new Set(asNumberArray(data.removedStructureIds));
    this.VisibleStructures = this.VisibleStructures.filter((structure) => !removed.has(structure.Id));

    for (const structure of asArray(data.updatedStructures)) {
      const parsed = VisibleStructure.fromServer(structure);
      this.VisibleStructures = this.VisibleStructures.filter((existing) => existing.Id !== parsed.Id);
      this.VisibleStructures.push(parsed);
    }
  }
}

export abstract class ActionBase {
  public constructor(public readonly Type: string) {}

  public toServerPayload(): ServerData {
    return { type: this.Type };
  }
}

export class MoveAction extends ActionBase {
  public constructor(public readonly NewPosition: Position) {
    super("Move");
  }

  public override toServerPayload(): ServerData {
    return { type: this.Type, newPosition: positionPayload(this.NewPosition) };
  }
}

export class GatherNodeAction extends ActionBase {
  public constructor(public readonly GatherPosition: Position) {
    super("Gather");
  }

  public override toServerPayload(): ServerData {
    return { type: this.Type, gatherPosition: positionPayload(this.GatherPosition) };
  }
}

export class AttackAction extends ActionBase {
  public constructor(public readonly TargetPosition: Position) {
    super("Attack");
  }

  public override toServerPayload(): ServerData {
    return { type: this.Type, targetPosition: positionPayload(this.TargetPosition) };
  }
}

export class DepositToBaseAction extends ActionBase {
  public constructor() {
    super("DepositToBase");
  }
}

export class WithdrawFromBaseAction extends ActionBase {
  public constructor(
    public readonly ItemName: string,
    public readonly ItemQuantity: number,
  ) {
    super("WithdrawFromBase");
  }

  public override toServerPayload(): ServerData {
    return { type: this.Type, itemName: this.ItemName, itemQuantity: this.ItemQuantity };
  }
}

export class SendCompanionAction extends ActionBase {
  public constructor() {
    super("SendCompanion");
  }
}

export class PlaceExtractorAction extends ActionBase {
  public constructor(public readonly TargetNodePosition: Position) {
    super("PlaceExtractor");
  }

  public override toServerPayload(): ServerData {
    return { type: this.Type, targetNodePosition: positionPayload(this.TargetNodePosition) };
  }
}

export class PlacePumpAction extends ActionBase {
  public constructor(public readonly TargetNodePosition: Position) {
    super("PlacePump");
  }

  public override toServerPayload(): ServerData {
    return { type: this.Type, targetNodePosition: positionPayload(this.TargetNodePosition) };
  }
}

export class PlaceRadarAction extends ActionBase {
  public constructor(public readonly TargetPosition: Position) {
    super("PlaceRadar");
  }

  public override toServerPayload(): ServerData {
    return { type: this.Type, targetPosition: positionPayload(this.TargetPosition) };
  }
}

export class DestroyStructureAction extends ActionBase {
  public constructor(public readonly StructurePosition: Position) {
    super("DestroyStructure");
  }

  public override toServerPayload(): ServerData {
    return { type: this.Type, structurePosition: positionPayload(this.StructurePosition) };
  }
}

export class AddItemToMuseumPedestalAction extends ActionBase {
  public constructor(
    public readonly SlotIndex: number,
    public readonly ItemName: string,
    public readonly Quantity = 0,
  ) {
    super("AddItemToMuseumPedestal");
  }

  public override toServerPayload(): ServerData {
    return {
      type: this.Type,
      slotIndex: this.SlotIndex,
      itemName: this.ItemName,
      quantity: this.Quantity,
    };
  }
}

export class RespawnAction extends ActionBase {
  public constructor() {
    super("Respawn");
  }
}


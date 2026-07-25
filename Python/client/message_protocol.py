# ============================== #
#                                #
#  NE PAS MODIFIER CE FICHIER    #
#   DO NOT MODIFY THIS FILE      #
#                                #
# ============================== #

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


def _get(data: dict[str, Any], key: str, default: Any = None) -> Any:
    return data[key] if key in data and data[key] is not None else default


def _position_from(data: dict[str, Any] | None) -> "Position":
    data = data or {}
    return Position(int(_get(data, "x", 0)), int(_get(data, "y", 0)))


def _inventory_from(values: list[dict[str, Any]] | None) -> list["ItemStack"]:
    return [
        ItemStack(str(_get(item, "itemName", "unknown")), int(_get(item, "quantity", 0)))
        for item in values or []
    ]


@dataclass(frozen=True)
class Position:
    X: int
    Y: int


@dataclass(frozen=True)
class Tile:
    Position: Position
    Terrain: str
    TerrainCategory: str
    Zone: str
    ZoneOwnerTeamId: int | None
    HasStructure: bool
    HasEntity: bool
    HasResource: bool


@dataclass(frozen=True)
class ItemStack:
    ItemName: str
    Quantity: int


@dataclass
class Resource:
    Id: int = 0
    Name: str = ""
    LootItem: str = ""
    Description: str = ""
    Position: Position = field(default_factory=lambda: Position(0, 0))
    CurrentAmount: int = 0
    Capacity: int = 0
    RemainingTicks: int = 0
    CanHostExtractor: bool = False
    CanHostPump: bool = False

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "Resource":
        return Resource(
            Id=int(_get(data, "id", 0)),
            Name=str(_get(data, "name", "unknown")),
            LootItem=str(_get(data, "lootItem", "")),
            Description=str(_get(data, "description", "")),
            Position=_position_from(_get(data, "position", {})),
            CurrentAmount=int(_get(data, "currentAmount", 0)),
            Capacity=int(_get(data, "capacity", 0)),
            RemainingTicks=int(_get(data, "remainingTicks", 0)),
            CanHostExtractor=bool(_get(data, "canHostExtractor", False)),
            CanHostPump=bool(_get(data, "canHostPump", False)),
        )


@dataclass
class PlayerInfo:
    Id: int = 0
    TeamId: int = 0
    BotType: str = "BotA"
    Health: int = 0
    MaxHealth: int = 0
    Shield: int = 0
    MaxShield: int = 0
    Position: Position = field(default_factory=lambda: Position(0, 0))
    Inventory: list[ItemStack] = field(default_factory=list)
    Slots: int = 0

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "PlayerInfo":
        return PlayerInfo(
            Id=int(_get(data, "id", 0)),
            TeamId=int(_get(data, "teamId", 0)),
            BotType=str(_get(data, "botType", "BotA")),
            Health=int(_get(data, "health", 0)),
            MaxHealth=int(_get(data, "maxHealth", 0)),
            Shield=int(_get(data, "shield", 0)),
            MaxShield=int(_get(data, "maxShield", 0)),
            Position=_position_from(_get(data, "position", {})),
            Inventory=_inventory_from(_get(data, "inventory", [])),
            Slots=int(_get(data, "slots", 0)),
        )


@dataclass
class VisiblePlayer:
    PlayerId: int = 0
    TeamId: int = 0
    BotType: str | None = None
    IsAlly: bool = False
    IsSelf: bool = False
    PvpActivated: bool = False
    Alive: bool = True
    RespawnRemainingTicks: int = 0
    Position: Position = field(default_factory=lambda: Position(0, 0))
    Health: int = 0
    MaxHealth: int = 0
    Shield: int = 0
    MaxShield: int = 0
    Slots: int = 0
    Inventory: list[ItemStack] = field(default_factory=list)

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "VisiblePlayer":
        return VisiblePlayer(
            PlayerId=int(_get(data, "playerId", _get(data, "id", 0))),
            TeamId=int(_get(data, "teamId", 0)),
            BotType=_get(data, "botType", None),
            IsAlly=bool(_get(data, "isAlly", False)),
            IsSelf=bool(_get(data, "isSelf", False)),
            PvpActivated=bool(_get(data, "pvpActivated", False)),
            Alive=bool(_get(data, "alive", True)),
            RespawnRemainingTicks=int(_get(data, "respawnRemainingTicks", 0)),
            Position=_position_from(_get(data, "position", {})),
            Health=int(_get(data, "health", 0)),
            MaxHealth=int(_get(data, "maxHealth", 0)),
            Shield=int(_get(data, "shield", 0)),
            MaxShield=int(_get(data, "maxShield", 0)),
            Slots=int(_get(data, "slots", 0)),
            Inventory=_inventory_from(_get(data, "inventory", [])),
        )


@dataclass
class VisibleCompanion:
    CompanionId: int = 0
    TeamId: int = 0
    OwnerPlayerId: int = 0
    IsAlly: bool = False
    PvpActivated: bool = False
    Position: Position = field(default_factory=lambda: Position(0, 0))
    Health: int = 0
    MaxHealth: int = 0
    InventoryItemsCount: int = 0

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "VisibleCompanion":
        return VisibleCompanion(
            CompanionId=int(_get(data, "companionId", 0)),
            TeamId=int(_get(data, "teamId", 0)),
            OwnerPlayerId=int(_get(data, "ownerPlayerId", 0)),
            IsAlly=bool(_get(data, "isAlly", False)),
            PvpActivated=bool(_get(data, "pvpActivated", False)),
            Position=_position_from(_get(data, "position", {})),
            Health=int(_get(data, "health", 0)),
            MaxHealth=int(_get(data, "maxHealth", 0)),
            InventoryItemsCount=int(_get(data, "inventoryItemsCount", 0)),
        )


@dataclass
class VisibleStructure:
    Id: int = 0
    Type: str = "Extractor"
    OwnerTeamId: int = 0
    OwnerBaseId: int = 0
    IsAlly: bool = False
    PvpActivated: bool = False
    Position: Position = field(default_factory=lambda: Position(0, 0))
    Width: int = 1
    Height: int = 1
    Hp: int = 0
    MaxHp: int = 0
    PowerOn: bool = False
    IsActive: bool = False
    VisionRadius: int = 0

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "VisibleStructure":
        return VisibleStructure(
            Id=int(_get(data, "id", 0)),
            Type=str(_get(data, "type", "Extractor")),
            OwnerTeamId=int(_get(data, "ownerTeamId", 0)),
            OwnerBaseId=int(_get(data, "ownerBaseId", 0)),
            IsAlly=bool(_get(data, "isAlly", False)),
            PvpActivated=bool(_get(data, "pvpActivated", False)),
            Position=_position_from(_get(data, "position", {})),
            Width=int(_get(data, "width", 1)),
            Height=int(_get(data, "height", 1)),
            Hp=int(_get(data, "hp", 0)),
            MaxHp=int(_get(data, "maxHp", 0)),
            PowerOn=bool(_get(data, "powerOn", False)),
            IsActive=bool(_get(data, "isActive", False)),
            VisionRadius=int(_get(data, "visionRadius", 0)),
        )


@dataclass
class ResearchJobInfo:
    Id: int = 0
    ResearchId: str = ""
    TotalTicks: int = 0
    RemainingTicks: int = 0

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "ResearchJobInfo":
        return ResearchJobInfo(int(_get(data, "id", 0)), str(_get(data, "researchId", "")), int(_get(data, "totalTicks", 0)), int(_get(data, "remainingTicks", 0)))


@dataclass
class BadgeInfo:
    Id: str = ""
    Name: str = ""
    Description: str = ""
    Category: str = ""
    MetricType: str = ""
    Hidden: bool = False
    Unlocked: bool = False
    Progress: float = 0
    NextTarget: float = 0

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "BadgeInfo":
        return BadgeInfo(
            Id=str(_get(data, "id", "")),
            Name=str(_get(data, "name", "")),
            Description=str(_get(data, "description", "")),
            Category=str(_get(data, "category", "")),
            MetricType=str(_get(data, "metricType", "")),
            Hidden=bool(_get(data, "hidden", False)),
            Unlocked=bool(_get(data, "unlocked", False)),
            Progress=float(_get(data, "progress", 0)),
            NextTarget=float(_get(data, "nextTarget", 0)),
        )


@dataclass
class ProcessingJobInfo:
    Id: int = 0
    RecipeId: str = ""
    TotalTicks: int = 0
    RemainingTicks: int = 0
    InputsPaid: bool = False
    RequestedRuns: int | None = None
    CompletedRuns: int = 0
    Repeat: bool = False

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "ProcessingJobInfo":
        return ProcessingJobInfo(
            Id=int(_get(data, "id", 0)),
            RecipeId=str(_get(data, "recipeId", "")),
            TotalTicks=int(_get(data, "totalTicks", 0)),
            RemainingTicks=int(_get(data, "remainingTicks", 0)),
            InputsPaid=bool(_get(data, "inputsPaid", False)),
            RequestedRuns=_get(data, "requestedRuns", None),
            CompletedRuns=int(_get(data, "completedRuns", 0)),
            Repeat=bool(_get(data, "repeat", False)),
        )


@dataclass
class GeneratorJobInfo:
    Id: int = 0
    ItemName: str = ""
    TotalTicks: int = 0
    RemainingTicks: int = 0
    ItemPaid: bool = False
    Repeat: bool = False
    WaitingForItem: bool = False

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "GeneratorJobInfo":
        return GeneratorJobInfo(
            Id=int(_get(data, "id", 0)),
            ItemName=str(_get(data, "itemName", "")),
            TotalTicks=int(_get(data, "totalTicks", 0)),
            RemainingTicks=int(_get(data, "remainingTicks", 0)),
            ItemPaid=bool(_get(data, "itemPaid", False)),
            Repeat=bool(_get(data, "repeat", False)),
            WaitingForItem=bool(_get(data, "waitingForItem", False)),
        )


@dataclass
class MuseumPedestalInfo:
    SlotIndex: int = 0
    ItemName: str | None = None
    Quantity: int = 0
    ValueBonus: float = 0
    MaxValueBonus: float = 0

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "MuseumPedestalInfo":
        return MuseumPedestalInfo(
            SlotIndex=int(_get(data, "slotIndex", 0)),
            ItemName=_get(data, "itemName", None),
            Quantity=int(_get(data, "quantity", 0)),
            ValueBonus=float(_get(data, "valueBonus", 0)),
            MaxValueBonus=float(_get(data, "maxValueBonus", 0)),
        )


@dataclass
class InternalStructureInfo:
    Type: str = ""
    Locked: bool = False
    MaxQueueSlots: int = 0
    MuseumSlots: int = 0
    MuseumBonusPerItem: float = 0
    MuseumMaxBonusPerItem: float = 0
    Queue: list[ProcessingJobInfo] = field(default_factory=list)
    GeneratorQueue: list[GeneratorJobInfo] = field(default_factory=list)
    Pedestals: list[MuseumPedestalInfo] = field(default_factory=list)

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "InternalStructureInfo":
        return InternalStructureInfo(
            Type=str(_get(data, "type", "")),
            Locked=bool(_get(data, "locked", False)),
            MaxQueueSlots=int(_get(data, "maxQueueSlots", 0)),
            MuseumSlots=int(_get(data, "museumSlots", 0)),
            MuseumBonusPerItem=float(_get(data, "museumBonusPerItem", 0)),
            MuseumMaxBonusPerItem=float(_get(data, "museumMaxBonusPerItem", 0)),
            Queue=[ProcessingJobInfo.from_dict(item) for item in _get(data, "queue", []) or []],
            GeneratorQueue=[GeneratorJobInfo.from_dict(item) for item in _get(data, "generatorQueue", []) or []],
            Pedestals=[MuseumPedestalInfo.from_dict(item) for item in _get(data, "pedestals", []) or []],
        )


@dataclass
class QuestStateInfo:
    SlotIndex: int = 0
    InstanceId: str = ""
    TemplateId: str = ""
    Name: str = ""
    Description: str = ""
    Type: str = ""
    MetricType: str = ""
    SubjectName: str = ""
    Progress: float = 0
    Target: float = 0
    Status: str = ""
    BaseReward: float = 0
    Reward: float = 0
    ResetAt: float | None = None
    RemainingResetSeconds: float = 0

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "QuestStateInfo":
        return QuestStateInfo(
            SlotIndex=int(_get(data, "slotIndex", 0)),
            InstanceId=str(_get(data, "instanceId", "")),
            TemplateId=str(_get(data, "templateId", "")),
            Name=str(_get(data, "name", "")),
            Description=str(_get(data, "description", "")),
            Type=str(_get(data, "type", "")),
            MetricType=str(_get(data, "metricType", "")),
            SubjectName=str(_get(data, "subjectName", "")),
            Progress=float(_get(data, "progress", 0)),
            Target=float(_get(data, "target", 0)),
            Status=str(_get(data, "status", "")),
            BaseReward=float(_get(data, "baseReward", 0)),
            Reward=float(_get(data, "reward", 0)),
            ResetAt=_get(data, "resetAt", None),
            RemainingResetSeconds=float(_get(data, "remainingResetSeconds", 0)),
        )


@dataclass
class TeamInfo:
    Id: int = 0
    Name: str = ""
    Score: float = 0
    LaboratoryLevel: int = 0
    LaboratoryQueuesNumber: int = 0
    LaboratoryProductionSpeed: float = 0
    GeneratorProductionSpeed: float = 0
    GeneratorScoreMultiplier: float = 0
    MuseumSlots: int = 0
    MuseumBonusPerItem: float = 0
    MuseumMaxBonusPerItem: float = 20
    CraftAutomaticCycle: bool = False
    PvpActivated: bool = False
    NumberOfExtractor: int = 0
    NumberOfPump: int = 0
    NumberOfRadar: int = 0
    CompanionNumber: int = 0
    CompanionMaxHp: int = 100
    CompanionSlots: int = 6
    CompletedResearchIds: list[str] = field(default_factory=list)
    ResearchQueue: list[ResearchJobInfo] = field(default_factory=list)
    QuestSlots: int = 0
    QuestTimerReset: float = 0
    BonusQuestComplete: float = 1
    QuestQueue: list[QuestStateInfo] = field(default_factory=list)
    Badges: list[BadgeInfo] = field(default_factory=list)

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "TeamInfo":
        return TeamInfo(
            Id=int(_get(data, "id", 0)),
            Name=str(_get(data, "name", "")),
            Score=float(_get(data, "score", 0)),
            LaboratoryLevel=int(_get(data, "laboratoryLevel", 0)),
            LaboratoryQueuesNumber=int(_get(data, "laboratoryQueuesNumber", 0)),
            LaboratoryProductionSpeed=float(_get(data, "laboratoryProductionSpeed", 0)),
            GeneratorProductionSpeed=float(_get(data, "generatorProductionSpeed", 0)),
            GeneratorScoreMultiplier=float(_get(data, "generatorScoreMultiplier", 0)),
            MuseumSlots=int(_get(data, "museumSlots", 0)),
            MuseumBonusPerItem=float(_get(data, "museumBonusPerItem", 0.01)),
            MuseumMaxBonusPerItem=float(_get(data, "museumMaxBonusPerItem", 20)),
            CraftAutomaticCycle=bool(_get(data, "craftAutomaticCycle", False)),
            PvpActivated=bool(_get(data, "pvpActivated", False)),
            NumberOfExtractor=int(_get(data, "numberOfExtractor", 0)),
            NumberOfPump=int(_get(data, "numberOfPump", 0)),
            NumberOfRadar=int(_get(data, "numberOfRadar", 0)),
            CompanionNumber=int(_get(data, "companionNumber", 0)),
            CompanionMaxHp=int(_get(data, "companionMaxHp", 100)),
            CompanionSlots=int(_get(data, "companionSlots", 6)),
            CompletedResearchIds=list(_get(data, "completedResearchIds", []) or []),
            ResearchQueue=[ResearchJobInfo.from_dict(item) for item in _get(data, "researchQueue", []) or []],
            QuestSlots=int(_get(data, "questSlots", 0)),
            QuestTimerReset=float(_get(data, "questTimerReset", 0)),
            BonusQuestComplete=float(_get(data, "bonusQuestComplete", 1)),
            QuestQueue=[QuestStateInfo.from_dict(item) for item in _get(data, "questQueue", []) or []],
            Badges=[BadgeInfo.from_dict(item) for item in _get(data, "badges", []) or []],
        )


@dataclass
class BaseInfo:
    Id: int = 0
    Position: Position = field(default_factory=lambda: Position(0, 0))
    Width: int = 0
    Height: int = 0
    StorageSlots: int = 0
    Inventory: list[ItemStack] = field(default_factory=list)
    InternalStructures: list[InternalStructureInfo] = field(default_factory=list)

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "BaseInfo":
        return BaseInfo(
            Id=int(_get(data, "id", 0)),
            Position=_position_from(_get(data, "position", {})),
            Width=int(_get(data, "width", 0)),
            Height=int(_get(data, "height", 0)),
            StorageSlots=int(_get(data, "storageSlots", 0)),
            Inventory=_inventory_from(_get(data, "inventory", [])),
            InternalStructures=[InternalStructureInfo.from_dict(item) for item in _get(data, "internalStructures", []) or []],
        )


@dataclass
class GameState:
    CurrentTick: int = 0
    VisibleTiles: dict[tuple[int, int], Tile] = field(default_factory=dict)
    VisibleResources: list[Resource] = field(default_factory=list)
    VisiblePlayers: list[VisiblePlayer] = field(default_factory=list)
    VisibleCompanions: list[VisibleCompanion] = field(default_factory=list)
    VisibleStructures: list[VisibleStructure] = field(default_factory=list)
    TeamPlayers: list[VisiblePlayer] = field(default_factory=list)
    Bot: PlayerInfo | None = None
    Team: TeamInfo | None = None
    Base: BaseInfo | None = None

    def update_player(self, data: dict[str, Any]) -> None:
        self.Bot = PlayerInfo.from_dict(data)

    def update_vision_from_server(self, data: dict[str, Any]) -> None:
        if bool(_get(data, "isComplete", True)):
            self.update_vision(data)
        else:
            self.update_partial_vision(data)

    def update_vision(self, data: dict[str, Any]) -> None:
        self._update_tiles(data)
        self._update_team(data)
        self._update_players(data)
        self._update_companions(data)
        self._update_resources(data)
        self._update_structures(data)

    def update_partial_vision(self, data: dict[str, Any]) -> None:
        self._update_team(data)
        self._update_tiles_delta(data)
        self._update_players_delta(data)
        self._update_companions_delta(data)
        self._update_resources_delta(data)
        self._update_structures_delta(data)

    def get_tile_at(self, pos: Position) -> Tile | None:
        return self.VisibleTiles.get((pos.X, pos.Y))

    def _update_tiles(self, data: dict[str, Any]) -> None:
        self.VisibleTiles.clear()
        for tile in _get(data, "tiles", []) or []:
            parsed = _tile_from(tile)
            self.VisibleTiles[(parsed.Position.X, parsed.Position.Y)] = parsed

    def _update_tiles_delta(self, data: dict[str, Any]) -> None:
        for tile in _get(data, "updatedTiles", []) or []:
            parsed = _tile_from(tile)
            self.VisibleTiles[(parsed.Position.X, parsed.Position.Y)] = parsed
        for position in _get(data, "removedTiles", []) or []:
            pos = _position_from(position)
            self.VisibleTiles.pop((pos.X, pos.Y), None)

    def _update_team(self, data: dict[str, Any]) -> None:
        if "team" in data and data["team"] is not None:
            self.Team = TeamInfo.from_dict(data["team"])
        if "base" in data and data["base"] is not None:
            self.Base = BaseInfo.from_dict(data["base"])

    def _update_players(self, data: dict[str, Any]) -> None:
        self.TeamPlayers = [VisiblePlayer.from_dict(player) for player in _get(data, "teamPlayers", []) or []]
        self.VisiblePlayers = [VisiblePlayer.from_dict(player) for player in _get(data, "visiblePlayers", []) or []]

    def _update_players_delta(self, data: dict[str, Any]) -> None:
        if "teamPlayers" in data:
            self.TeamPlayers = [VisiblePlayer.from_dict(player) for player in _get(data, "teamPlayers", []) or []]
        removed = set(_get(data, "removedPlayerIds", []) or [])
        self.VisiblePlayers = [player for player in self.VisiblePlayers if player.PlayerId not in removed]
        for player in _get(data, "updatedPlayers", []) or []:
            parsed = VisiblePlayer.from_dict(player)
            self.VisiblePlayers = [existing for existing in self.VisiblePlayers if existing.PlayerId != parsed.PlayerId]
            self.VisiblePlayers.append(parsed)

    def _update_companions(self, data: dict[str, Any]) -> None:
        self.VisibleCompanions = [VisibleCompanion.from_dict(companion) for companion in _get(data, "visibleCompanions", []) or []]

    def _update_companions_delta(self, data: dict[str, Any]) -> None:
        removed = set(_get(data, "removedCompanionIds", []) or [])
        self.VisibleCompanions = [companion for companion in self.VisibleCompanions if companion.CompanionId not in removed]
        for companion in _get(data, "updatedCompanions", []) or []:
            parsed = VisibleCompanion.from_dict(companion)
            self.VisibleCompanions = [existing for existing in self.VisibleCompanions if existing.CompanionId != parsed.CompanionId]
            self.VisibleCompanions.append(parsed)

    def _update_resources(self, data: dict[str, Any]) -> None:
        self.VisibleResources = [Resource.from_dict(resource) for resource in _get(data, "resources", []) or []]

    def _update_resources_delta(self, data: dict[str, Any]) -> None:
        removed = set(_get(data, "removedResourceIds", []) or [])
        self.VisibleResources = [resource for resource in self.VisibleResources if resource.Id not in removed]
        for resource in _get(data, "updatedResources", []) or []:
            parsed = Resource.from_dict(resource)
            self.VisibleResources = [existing for existing in self.VisibleResources if existing.Id != parsed.Id]
            self.VisibleResources.append(parsed)

    def _update_structures(self, data: dict[str, Any]) -> None:
        self.VisibleStructures = [VisibleStructure.from_dict(structure) for structure in _get(data, "visibleStructures", []) or []]

    def _update_structures_delta(self, data: dict[str, Any]) -> None:
        removed = set(_get(data, "removedStructureIds", []) or [])
        self.VisibleStructures = [structure for structure in self.VisibleStructures if structure.Id not in removed]
        for structure in _get(data, "updatedStructures", []) or []:
            parsed = VisibleStructure.from_dict(structure)
            self.VisibleStructures = [existing for existing in self.VisibleStructures if existing.Id != parsed.Id]
            self.VisibleStructures.append(parsed)


def _tile_from(data: dict[str, Any]) -> Tile:
    x = int(_get(data, "x", 0))
    y = int(_get(data, "y", 0))
    return Tile(
        Position=Position(x, y),
        Terrain=str(_get(data, "terrain", "Empty")),
        TerrainCategory=str(_get(data, "terrainCategory", "Land")),
        Zone=str(_get(data, "zone", "WarZone")),
        ZoneOwnerTeamId=_get(data, "zoneOwnerTeamId", None),
        HasStructure=bool(_get(data, "hasStructure", False)),
        HasEntity=bool(_get(data, "hasEntity", False)),
        HasResource=bool(_get(data, "hasResource", False)),
    )


@dataclass
class ActionBase:
    Type: str = ""

    def to_server_payload(self) -> dict[str, Any]:
        return {"type": self.Type}


@dataclass
class MoveAction(ActionBase):
    NewPosition: Position = field(default_factory=lambda: Position(0, 0))

    def __init__(self, new_position: Position):
        super().__init__("Move")
        self.NewPosition = new_position

    def to_server_payload(self) -> dict[str, Any]:
        return {"type": self.Type, "newPosition": _position_payload(self.NewPosition)}


@dataclass
class GatherNodeAction(ActionBase):
    GatherPosition: Position = field(default_factory=lambda: Position(0, 0))

    def __init__(self, gather_position: Position):
        super().__init__("Gather")
        self.GatherPosition = gather_position

    def to_server_payload(self) -> dict[str, Any]:
        return {"type": self.Type, "gatherPosition": _position_payload(self.GatherPosition)}


@dataclass
class AttackAction(ActionBase):
    TargetPosition: Position = field(default_factory=lambda: Position(0, 0))

    def __init__(self, target_position: Position):
        super().__init__("Attack")
        self.TargetPosition = target_position

    def to_server_payload(self) -> dict[str, Any]:
        return {"type": self.Type, "targetPosition": _position_payload(self.TargetPosition)}


class DepositToBaseAction(ActionBase):
    def __init__(self):
        super().__init__("DepositToBase")


@dataclass
class WithdrawFromBaseAction(ActionBase):
    ItemName: str = ""
    ItemQuantity: int = 0

    def __init__(self, item_name: str, item_quantity: int):
        super().__init__("WithdrawFromBase")
        self.ItemName = item_name
        self.ItemQuantity = item_quantity

    def to_server_payload(self) -> dict[str, Any]:
        return {"type": self.Type, "itemName": self.ItemName, "itemQuantity": self.ItemQuantity}


class SendCompanionAction(ActionBase):
    def __init__(self):
        super().__init__("SendCompanion")


@dataclass
class PlaceExtractorAction(ActionBase):
    TargetNodePosition: Position = field(default_factory=lambda: Position(0, 0))

    def __init__(self, target_node_position: Position):
        super().__init__("PlaceExtractor")
        self.TargetNodePosition = target_node_position

    def to_server_payload(self) -> dict[str, Any]:
        return {"type": self.Type, "targetNodePosition": _position_payload(self.TargetNodePosition)}


@dataclass
class PlacePumpAction(ActionBase):
    TargetNodePosition: Position = field(default_factory=lambda: Position(0, 0))

    def __init__(self, target_node_position: Position):
        super().__init__("PlacePump")
        self.TargetNodePosition = target_node_position

    def to_server_payload(self) -> dict[str, Any]:
        return {"type": self.Type, "targetNodePosition": _position_payload(self.TargetNodePosition)}


@dataclass
class PlaceRadarAction(ActionBase):
    TargetPosition: Position = field(default_factory=lambda: Position(0, 0))

    def __init__(self, target_position: Position):
        super().__init__("PlaceRadar")
        self.TargetPosition = target_position

    def to_server_payload(self) -> dict[str, Any]:
        return {"type": self.Type, "targetPosition": _position_payload(self.TargetPosition)}


@dataclass
class DestroyStructureAction(ActionBase):
    StructurePosition: Position = field(default_factory=lambda: Position(0, 0))

    def __init__(self, structure_position: Position):
        super().__init__("DestroyStructure")
        self.StructurePosition = structure_position

    def to_server_payload(self) -> dict[str, Any]:
        return {"type": self.Type, "structurePosition": _position_payload(self.StructurePosition)}


@dataclass
class AddItemToMuseumPedestalAction(ActionBase):
    SlotIndex: int = 0
    ItemName: str = ""
    Quantity: int = 0

    def __init__(self, slot_index: int, item_name: str, quantity: int = 0):
        super().__init__("AddItemToMuseumPedestal")
        self.SlotIndex = slot_index
        self.ItemName = item_name
        self.Quantity = quantity

    def to_server_payload(self) -> dict[str, Any]:
        return {"type": self.Type, "slotIndex": self.SlotIndex, "itemName": self.ItemName, "quantity": self.Quantity}


class RespawnAction(ActionBase):
    def __init__(self):
        super().__init__("Respawn")


def _position_payload(position: Position) -> dict[str, int]:
    return {"x": position.X, "y": position.Y}

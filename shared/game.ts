export type PlayerId = "captainA" | "captainB";

export type RoomPhase = "lobby" | "deploy" | "combat" | "finished";

export type ShipClassId = "hauler" | "skiff" | "cutter";

export type SystemId =
  | "engines"
  | "shields"
  | "weapons"
  | "sensors"
  | "lifeSupport";

export type CommandType = "fire" | "repair" | "brace" | "jam" | "evasive" | "patch" | "redeploy";

export interface ShipSystemDefinition {
  id: SystemId;
  name: string;
  maxHp: number;
  description: string;
}

export interface ShipSystemState extends ShipSystemDefinition {
  hp: number;
}

export interface Ship {
  owner: PlayerId;
  classId: ShipClassId;
  name: string;
  maxHull: number;
  hull: number;
  maxShield: number;
  shield: number;
  storedShield?: number;
  crewTotal: number;
  crewAssignments: Record<SystemId, number>;
  systems: Record<SystemId, ShipSystemState>;
  oxygenDeadlineTurn?: number;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  connected: boolean;
  shipClassId: ShipClassId;
  crewDeployed?: boolean;
  credits: number;
  systemUpgrades: Record<SystemId, number>;
  shieldBraces: number;
  breachSeals: number;
  rematchReady?: boolean;
  deviceId?: string;
}

export interface SpectatorState {
  id: string;
  name: string;
  connected: boolean;
}

export interface ChatMessage {
  id: string;
  author: string;
  role: "captainA" | "captainB" | "spectator";
  text: string;
  createdAt: number;
}

export interface RecentGame {
  id: string;
  roomCode: string;
  winnerName: string;
  loserName: string;
  rounds: number;
  completedAt: number;
}

export interface CombatCommand {
  type: CommandType;
  targetSystem?: SystemId;
  repairSystem?: SystemId;
  crewAssignments?: Partial<Record<SystemId, number>>;
}

export interface RoomState {
  code: string;
  phase: RoomPhase;
  players: Partial<Record<PlayerId, PlayerState>>;
  spectators: Record<string, SpectatorState>;
  ships: Partial<Record<PlayerId, Ship>>;
  turn: number;
  activePlayer?: PlayerId;
  log: string[];
  chat: ChatMessage[];
  winner?: PlayerId;
  sessionGameWins?: Partial<Record<PlayerId, number>>;
}

export interface ClientRoomState extends RoomState {
  you?: PlayerId;
  spectatorId?: string;
}

export const PLAYER_IDS: PlayerId[] = ["captainA", "captainB"];

export {
  createShip,
  DEFAULT_SHIP_CLASS_ID,
  formatShipClassSummary,
  getShipClass,
  isShipClassId,
  SHIP_CLASSES
} from "./ships";

export {
  applyCrewUpkeep,
  createCrewAssignments,
  crewAssignmentsEqual,
  damageShipSystem,
  formatCrewCasualtyEntry,
  formatCrewDeployment,
  getAssignedCrewCount,
  getCrewAtStation,
  getCrewAccuracyBonus,
  getCrewCritBonus,
  getCrewEvasionBonus,
  getCrewLifeSupportMitigation,
  getCrewTotal,
  MAX_CREW_PER_STATION,
  sanitizeCrewAssignments
} from "./crew";

export {
  applySystemUpgrades,
  calculateLoserCredits,
  calculateWinnerCredits,
  createDefaultSystemUpgrades,
  formatLoserCreditsSummary,
  formatUpgradePurchase,
  formatVictoryCreditsSummary,
  getUpgradeCost,
  getUpgradeRefund,
  getUpgradeHpBonus,
  MAX_UPGRADE_LEVEL,
  MIN_UPGRADE_LEVEL,
  normalizeSystemUpgrades,
  type SystemUpgrades,
  type VictoryCreditsBreakdown
} from "./upgrades";

export {
  createEmptyPlayerStats,
  finalizeSessionMatch,
  isValidDeviceId,
  recordSessionGameWin,
  type PlayerStats,
  type SessionMatchResult
} from "./playerStats";

export {
  canPurchaseConsumable,
  CONSUMABLES,
  createDefaultConsumables,
  formatConsumablePurchase,
  getConsumableDefinition,
  getConsumableStock,
  isConsumableId,
  MAX_CONSUMABLE_STOCK,
  STARTING_BREACH_SEALS,
  STARTING_SHIELD_BRACES,
  type ConsumableDefinition,
  type ConsumableId
} from "./consumables";

import { createShip, DEFAULT_SHIP_CLASS_ID, getShipClass, isShipClassId } from "./ships";
import {
  applyCrewUpkeep,
  crewAssignmentsEqual,
  damageShipSystem,
  formatCrewCasualtyEntry,
  formatCrewDeployment,
  getCrewAccuracyBonus,
  getCrewCritBonus,
  getCrewEvasionBonus,
  sanitizeCrewAssignments
} from "./crew";
import {
  applySystemUpgrades,
  calculateLoserCredits,
  calculateWinnerCredits,
  createDefaultSystemUpgrades,
  formatLoserCreditsSummary,
  formatUpgradePurchase,
  formatUpgradeRefund,
  formatVictoryCreditsSummary,
  getUpgradeCost,
  getUpgradeRefund,
  normalizeSystemUpgrades
} from "./upgrades";
import { createDefaultConsumables, normalizeConsumables, canPurchaseConsumable, formatConsumablePurchase, getConsumableDefinition, isConsumableId, type ConsumableId } from "./consumables";

export function createDefaultPlayerState(
  id: PlayerId,
  name: string,
  connected: boolean,
  shipClassId: ShipClassId = DEFAULT_SHIP_CLASS_ID,
  deviceId?: string
): PlayerState {
  return {
    id,
    name,
    connected,
    shipClassId,
    credits: 0,
    systemUpgrades: createDefaultSystemUpgrades(),
    ...createDefaultConsumables(),
    deviceId
  };
}

export function ensurePlayerProgress(player: PlayerState): PlayerState {
  return {
    ...player,
    credits: player.credits ?? 0,
    systemUpgrades: normalizeSystemUpgrades(player.systemUpgrades),
    ...normalizeConsumables(player)
  };
}

export function resetPlayerProgress(player: PlayerState): PlayerState {
  return {
    ...player,
    credits: 0,
    systemUpgrades: createDefaultSystemUpgrades(),
    ...createDefaultConsumables(),
    crewDeployed: undefined
  };
}

export const SYSTEM_DEFINITIONS: ShipSystemDefinition[] = [
  {
    id: "engines",
    name: "Engines",
    maxHp: 5,
    description: "Improves evasion and maneuvering."
  },
  {
    id: "shields",
    name: "Shields",
    maxHp: 5,
    description: "Charges defensive layers before attacks hit hull."
  },
  {
    id: "weapons",
    name: "Weapons",
    maxHp: 5,
    description: "Enables accurate ship-to-ship attacks."
  },
  {
    id: "sensors",
    name: "Sensors",
    maxHp: 4,
    description: "Improves targeting and reveals weak points."
  },
  {
    id: "lifeSupport",
    name: "Life Support",
    maxHp: 4,
    description: "Keeps the crew fighting through prolonged damage."
  }
];

export const DEFAULT_TARGET_SYSTEM: SystemId = "weapons";

export const DEFAULT_COMMAND: CombatCommand = {
  type: "brace"
};

export const CRITICAL_STRIKE_LOG_MARKER = "CRITICAL STRIKE";
export const HULL_PUNCTURE_LOG_MARKER = "HULL PUNCTURE";
export const BATTLE_END_LOG_MARKER = "wins the battle";
export const SUFFOCATION_TURNS = 3;
export const BATTLE_LOG_LIMIT = 80;

export function appendToBattleLog(log: string[], ...entries: string[]): string[] {
  if (entries.length === 0) {
    return log.slice(-BATTLE_LOG_LIMIT);
  }

  return [...log, ...entries].slice(-BATTLE_LOG_LIMIT);
}

function appendBattleEndLog(log: string[], turnEntries: string[], endEntries: string[]): string[] {
  const protectedCount = turnEntries.length + endEntries.length;
  const historyLimit = Math.max(BATTLE_LOG_LIMIT - protectedCount, 0);

  return [...log.slice(-historyLimit), ...turnEntries, ...endEntries];
}

const CRITICAL_STRIKE_BASE_CHANCE = 5;
const CRITICAL_STRIKE_SENSOR_BONUS = 14;
const CRITICAL_STRIKE_WEAPON_BONUS = 8;
const CRITICAL_STRIKE_MAX_CHANCE = 28;
const CRITICAL_STRIKE_HULL_BONUS = 3;
const CRITICAL_STRIKE_SYSTEM_BONUS = 2;
const CRITICAL_PUNCTURE_CHANCE = 40;

export function getSuffocationTurnsRemaining(ship: Ship, currentTurn: number): number | undefined {
  if (ship.oxygenDeadlineTurn === undefined || ship.hull <= 0) {
    return undefined;
  }

  const remaining = ship.oxygenDeadlineTurn - currentTurn;
  return remaining > 0 ? remaining : undefined;
}

export function getCriticalStrikeChance(ship: Ship): number {
  const sensorBonus = integrityPercent(ship, "sensors") * CRITICAL_STRIKE_SENSOR_BONUS;
  const weaponBonus = integrityPercent(ship, "weapons") >= 0.8 ? CRITICAL_STRIKE_WEAPON_BONUS : 0;
  const crewBonus = getCrewCritBonus(ship);
  return Math.round(
    clamp(
      CRITICAL_STRIKE_BASE_CHANCE + sensorBonus + weaponBonus + crewBonus,
      CRITICAL_STRIKE_BASE_CHANCE,
      CRITICAL_STRIKE_MAX_CHANCE
    )
  );
}

export function createRoom(code: string): RoomState {
  return {
    code,
    phase: "lobby",
    players: {},
    spectators: {},
    ships: {},
    turn: 1,
    activePlayer: undefined,
    log: [`Room ${code} created. Waiting for captains.`],
    chat: []
  };
}

export function selectShipClass(room: RoomState, playerId: PlayerId, classId: ShipClassId): RoomState {
  const player = room.players[playerId];

  if (room.phase !== "lobby" || !player || !isShipClassId(classId)) {
    return room;
  }

  if (player.shipClassId === classId) {
    return room;
  }

  const shipClass = getShipClass(classId);

  return {
    ...room,
    players: {
      ...room.players,
      [playerId]: {
        ...player,
        shipClassId: classId
      }
    },
    log: appendToBattleLog(room.log, `${playerLabel(room, playerId)} selects the ${shipClass.name}.`)
  };
}

function shipClassForPlayer(room: RoomState, playerId: PlayerId): ShipClassId {
  return room.players[playerId]?.shipClassId ?? DEFAULT_SHIP_CLASS_ID;
}

function buildCombatShips(room: RoomState): Record<PlayerId, Ship> {
  return {
    captainA: applySystemUpgrades(
      createShip("captainA", shipClassForPlayer(room, "captainA")),
      room.players.captainA?.systemUpgrades
    ),
    captainB: applySystemUpgrades(
      createShip("captainB", shipClassForPlayer(room, "captainB")),
      room.players.captainB?.systemUpgrades
    )
  };
}

export function getOpponent(playerId: PlayerId): PlayerId {
  return playerId === "captainA" ? "captainB" : "captainA";
}

export function serializeRoom(room: RoomState, you?: PlayerId, spectatorId?: string): ClientRoomState {
  return {
    code: room.code,
    phase: room.phase,
    players: room.players,
    spectators: room.spectators,
    ships: room.ships,
    turn: room.turn,
    activePlayer: room.activePlayer,
    log: room.log,
    chat: room.chat,
    winner: room.winner,
    you,
    spectatorId
  };
}

export function canStartCombat(room: RoomState): boolean {
  return PLAYER_IDS.every((id) => room.players[id]?.connected);
}

export function bothCrewDeployed(room: RoomState): boolean {
  return PLAYER_IDS.every((id) => room.players[id]?.connected && room.players[id]?.crewDeployed);
}

export function beginDeploy(room: RoomState): RoomState {
  if (!canStartCombat(room) || room.phase !== "lobby") {
    return room;
  }

  const players = { ...room.players };
  for (const playerId of PLAYER_IDS) {
    const player = players[playerId];
    if (player) {
      players[playerId] = {
        ...player,
        crewDeployed: false
      };
    }
  }

  return {
    ...room,
    phase: "deploy",
    ships: buildCombatShips(room),
    players,
    turn: 1,
    activePlayer: undefined,
    winner: undefined,
    log: appendToBattleLog(room.log, "Both captains are connected. Deploy your crew before combat begins.")
  };
}

export function submitCrewDeployment(
  room: RoomState,
  playerId: PlayerId,
  assignments?: Partial<Record<SystemId, number>>
): RoomState {
  const player = room.players[playerId];
  const ship = room.ships[playerId];

  if (room.phase !== "deploy" || !player || !ship) {
    return room;
  }

  const normalized = sanitizeCrewAssignments(ship, assignments);
  if (!normalized) {
    return room;
  }

  return {
    ...room,
    ships: {
      ...room.ships,
      [playerId]: {
        ...ship,
        crewAssignments: normalized
      }
    },
    players: {
      ...room.players,
      [playerId]: {
        ...player,
        crewDeployed: true
      }
    },
    log: appendToBattleLog(room.log, `${playerLabel(room, playerId)} confirms crew deployment.`)
  };
}

export function launchCombat(room: RoomState): RoomState {
  if (room.phase !== "deploy" || !bothCrewDeployed(room)) {
    return room;
  }

  const players = { ...room.players };
  for (const playerId of PLAYER_IDS) {
    const player = players[playerId];
    if (player) {
      players[playerId] = {
        ...player,
        crewDeployed: undefined
      };
    }
  }

  const firstPlayer = pickFirstCombatPlayer(room);

  return {
    ...room,
    phase: "combat",
    players,
    turn: 1,
    activePlayer: firstPlayer,
    winner: undefined,
    log: appendToBattleLog(
      room.log,
      `${playerLabel(room, "captainA")} deploys a ${getShipClass(shipClassForPlayer(room, "captainA")).name}. ${playerLabel(room, "captainB")} deploys a ${getShipClass(shipClassForPlayer(room, "captainB")).name}.`,
      `Combat begins. ${playerLabel(room, firstPlayer)} has the first action.`
    )
  };
}

export function startCombat(room: RoomState): RoomState {
  return beginDeploy(room);
}

export function canRematch(room: RoomState): boolean {
  return room.phase === "finished" && canStartCombat(room);
}

export function purchaseSystemUpgrade(
  room: RoomState,
  playerId: PlayerId,
  systemId: SystemId
): RoomState {
  const rawPlayer = room.players[playerId];

  if (room.phase !== "finished" || !rawPlayer) {
    return room;
  }

  const player = ensurePlayerProgress(rawPlayer);

  const system = SYSTEM_DEFINITIONS.find((entry) => entry.id === systemId);
  if (!system) {
    return room;
  }

  const upgrades = normalizeSystemUpgrades(player.systemUpgrades);
  const currentLevel = upgrades[systemId];
  const cost = getUpgradeCost(currentLevel);

  if (!cost || player.credits < cost) {
    return room;
  }

  const nextLevel = currentLevel + 1;

  return {
    ...room,
    players: {
      ...room.players,
      [playerId]: {
        ...player,
        credits: player.credits - cost,
        systemUpgrades: {
          ...upgrades,
          [systemId]: nextLevel
        }
      }
    },
    log: appendToBattleLog(
      room.log,
      formatUpgradePurchase(playerLabel(room, playerId), system.name, nextLevel, cost)
    )
  };
}

export function purchaseConsumableCharge(
  room: RoomState,
  playerId: PlayerId,
  consumableId: ConsumableId
): RoomState {
  const rawPlayer = room.players[playerId];

  if (room.phase !== "finished" || !rawPlayer || !isConsumableId(consumableId)) {
    return room;
  }

  const player = ensurePlayerProgress(rawPlayer);
  const item = getConsumableDefinition(consumableId);

  if (!canPurchaseConsumable(player, consumableId)) {
    return room;
  }

  const nextStock =
    consumableId === "shieldBrace" ? player.shieldBraces + 1 : player.breachSeals + 1;

  return {
    ...room,
    players: {
      ...room.players,
      [playerId]: {
        ...player,
        credits: player.credits - item.cost,
        shieldBraces: consumableId === "shieldBrace" ? nextStock : player.shieldBraces,
        breachSeals: consumableId === "breachSeal" ? nextStock : player.breachSeals
      }
    },
    log: appendToBattleLog(
      room.log,
      formatConsumablePurchase(playerLabel(room, playerId), item.name, nextStock, item.cost)
    )
  };
}

export function refundSystemUpgrade(
  room: RoomState,
  playerId: PlayerId,
  systemId: SystemId
): RoomState {
  const rawPlayer = room.players[playerId];

  if (room.phase !== "finished" || !rawPlayer) {
    return room;
  }

  const player = ensurePlayerProgress(rawPlayer);
  const system = SYSTEM_DEFINITIONS.find((entry) => entry.id === systemId);

  if (!system) {
    return room;
  }

  const upgrades = normalizeSystemUpgrades(player.systemUpgrades);
  const currentLevel = upgrades[systemId];
  const refund = getUpgradeRefund(currentLevel);

  if (!refund) {
    return room;
  }

  const nextLevel = currentLevel - 1;

  return {
    ...room,
    players: {
      ...room.players,
      [playerId]: {
        ...player,
        credits: player.credits + refund,
        systemUpgrades: {
          ...upgrades,
          [systemId]: nextLevel
        }
      }
    },
    log: appendToBattleLog(
      room.log,
      formatUpgradeRefund(playerLabel(room, playerId), system.name, nextLevel, refund)
    )
  };
}

export function markRematchReady(room: RoomState, playerId: PlayerId): RoomState {
  if (room.phase !== "finished" || !canRematch(room)) {
    return room;
  }

  const rawPlayer = room.players[playerId];

  if (!rawPlayer || rawPlayer.rematchReady) {
    return room;
  }

  const players = {
    ...room.players,
    [playerId]: {
      ...ensurePlayerProgress(rawPlayer),
      rematchReady: true
    }
  };

  const readyRoom = {
    ...room,
    players,
    log: appendToBattleLog(room.log, `${playerLabel(room, playerId)} is ready for the next battle.`)
  };

  if (bothRematchReady(readyRoom)) {
    return rematchCombat(readyRoom);
  }

  return readyRoom;
}

export function rematchCombat(room: RoomState): RoomState {
  if (!canRematch(room)) {
    return room;
  }

  const players = { ...room.players };
  for (const playerId of PLAYER_IDS) {
    const player = players[playerId];
    if (player) {
      players[playerId] = {
        ...player,
        crewDeployed: false,
        rematchReady: undefined
      };
    }
  }

  return {
    ...room,
    phase: "deploy",
    ships: buildCombatShips(room),
    players,
    turn: 1,
    activePlayer: undefined,
    winner: undefined,
    log: appendToBattleLog(room.log, "Rematch ready. Deploy your crew before the next battle.")
  };
}

export function normalizeCommand(command: CombatCommand): CombatCommand {
  if (command.type === "fire") {
    return {
      type: "fire",
      targetSystem: command.targetSystem ?? DEFAULT_TARGET_SYSTEM
    };
  }

  if (command.type === "repair") {
    return {
      type: "repair",
      repairSystem: command.repairSystem ?? DEFAULT_TARGET_SYSTEM
    };
  }

  if (command.type === "jam") {
    return {
      type: "jam"
    };
  }

  if (command.type === "evasive") {
    return {
      type: "evasive"
    };
  }

  if (command.type === "patch") {
    return {
      type: "patch"
    };
  }

  if (command.type === "redeploy") {
    return {
      type: "redeploy",
      crewAssignments: command.crewAssignments
    };
  }

  return DEFAULT_COMMAND;
}

export function resolvePlayerTurn(room: RoomState, playerId: PlayerId, command: CombatCommand): RoomState {
  const captainA = room.ships.captainA;
  const captainB = room.ships.captainB;

  if (room.phase !== "combat" || !captainA || !captainB || room.activePlayer !== playerId) {
    return room;
  }

  const ships: Record<PlayerId, Ship> = {
    captainA: cloneShip(captainA),
    captainB: cloneShip(captainB)
  };
  const normalizedCommand = normalizeCommand(command);
  const opponent = getOpponent(playerId);
  const label = (id: PlayerId) => playerLabel(room, id);
  const entries: string[] = [`Turn ${room.turn}: ${label(playerId)} acts.`];

  applyCrewUpkeep(playerId, ships[playerId], entries, label);

  const players = { ...room.players };
  let actingPlayer = players[playerId] ? ensurePlayerProgress(players[playerId]!) : undefined;

  if (normalizedCommand.type === "redeploy") {
    applyRedeployCommand(playerId, ships[playerId], normalizedCommand, entries, label);
  } else if (actingPlayer) {
    actingPlayer = applyPreparationCommand(
      playerId,
      ships[playerId],
      normalizedCommand,
      entries,
      label,
      actingPlayer
    );
    applyElectronicCommand(playerId, ships[playerId], ships[opponent], normalizedCommand, entries, label);
    applyFireCommand(playerId, ships[playerId], ships[opponent], normalizedCommand, room.turn, entries, label);
    players[playerId] = actingPlayer;
  } else {
    applyElectronicCommand(playerId, ships[playerId], ships[opponent], normalizedCommand, entries, label);
    applyFireCommand(playerId, ships[playerId], ships[opponent], normalizedCommand, room.turn, entries, label);
  }

  for (const id of PLAYER_IDS) {
    applySuffocationPressure(id, ships[id], room.turn, entries, label);
  }

  const winner = determineWinner(ships);
  let nextLog: string[];
  let nextPlayers = players;

  if (winner) {
    const loser = getOpponent(winner);
    const endEntries: string[] = [];
    nextPlayers = applyVictoryCredits(room, ships, winner, room.turn, endEntries, players);
    endEntries.push(formatBattleVictoryMessage(winner, loser, ships, entries, label));
    nextLog = appendBattleEndLog(room.log, entries, endEntries);
  } else {
    nextLog = appendToBattleLog(room.log, ...entries);
  }

  return {
    ...room,
    phase: winner ? "finished" : "combat",
    ships,
    players: nextPlayers,
    turn: room.turn + 1,
    activePlayer: winner ? undefined : opponent,
    log: nextLog,
    winner
  };
}

function applyVictoryCredits(
  room: RoomState,
  ships: Record<PlayerId, Ship>,
  winner: PlayerId,
  turn: number,
  log: string[],
  currentPlayers: Partial<Record<PlayerId, PlayerState>>
): Partial<Record<PlayerId, PlayerState>> {
  const players = { ...currentPlayers };

  for (const playerId of PLAYER_IDS) {
    const player = players[playerId];
    const ship = ships[playerId];

    if (!player || !ship) {
      continue;
    }

    if (playerId === winner) {
      const breakdown = calculateWinnerCredits(ship, turn);
      log.push(formatVictoryCreditsSummary(playerLabel(room, playerId), breakdown));
      players[playerId] = {
        ...ensurePlayerProgress(player),
        credits: player.credits + breakdown.total
      };
      continue;
    }

    const consolation = calculateLoserCredits(turn);
    log.push(formatLoserCreditsSummary(playerLabel(room, playerId), consolation));
    players[playerId] = {
      ...ensurePlayerProgress(player),
      credits: player.credits + consolation
    };
  }

  return players;
}

function applyRedeployCommand(
  playerId: PlayerId,
  ship: Ship,
  command: CombatCommand,
  entries: string[],
  label: (playerId: PlayerId) => string
) {
  const nextAssignments = sanitizeCrewAssignments(ship, command.crewAssignments);

  if (!nextAssignments) {
    entries.push(`${label(playerId)} tries to redeploy crew, but the new assignments are invalid.`);
    return;
  }

  if (crewAssignmentsEqual(nextAssignments, ship.crewAssignments)) {
    entries.push(`${label(playerId)} keeps crew at their current stations.`);
    return;
  }

  ship.crewAssignments = nextAssignments;
  entries.push(`${label(playerId)} redeploys crew: ${formatCrewDeployment(nextAssignments)}.`);
}

function applyPreparationCommand(
  playerId: PlayerId,
  ship: Ship,
  command: CombatCommand,
  entries: string[],
  label: (playerId: PlayerId) => string,
  player: PlayerState
): PlayerState {
  if (command.type === "repair") {
    const systemId = command.repairSystem ?? DEFAULT_TARGET_SYSTEM;
    const system = ship.systems[systemId];
    const repairAmount = 2;
    const previousHp = system.hp;
    system.hp = clamp(system.hp + repairAmount, 0, system.maxHp);

    if (systemId === "shields" && previousHp === 0 && system.hp > 0) {
      ship.shield = clamp(ship.storedShield ?? ship.maxShield, 0, ship.maxShield);
      ship.storedShield = undefined;
    }

    if (systemId === "lifeSupport" && system.hp > 0) {
      clearSuffocation(ship, entries, label(playerId), "Life support restored. Cabin pressure stabilizes.");
    }
    entries.push(
      `${label(playerId)} repairs ${system.name} from ${previousHp}/${system.maxHp} to ${system.hp}/${system.maxHp}.`
    );
    return player;
  }

  if (command.type === "brace") {
    if (player.shieldBraces <= 0) {
      entries.push(`${label(playerId)} tries to brace shields, but no shield brace charges remain.`);
      return player;
    }

    const shieldGain = isSystemOnline(ship, "shields") ? 2 : 1;
    ship.shield = clamp(ship.shield + shieldGain, 0, ship.maxShield);
    entries.push(
      `${label(playerId)} braces behind reinforced shields (${player.shieldBraces - 1} brace charge${player.shieldBraces - 1 === 1 ? "" : "s"} left).`
    );
    return {
      ...player,
      shieldBraces: player.shieldBraces - 1
    };
  }

  if (command.type === "evasive") {
    const previousEngines = ship.systems.engines.hp;
    ship.systems.engines.hp = clamp(ship.systems.engines.hp + 1, 0, ship.systems.engines.maxHp);
    ship.shield = clamp(ship.shield + 1, 0, ship.maxShield);
    entries.push(
      `${label(playerId)} takes evasive maneuvers, tuning engines from ${previousEngines}/${ship.systems.engines.maxHp} to ${ship.systems.engines.hp}/${ship.systems.engines.maxHp} and adding 1 shield.`
    );
    return player;
  }

  if (command.type === "patch") {
    let nextPlayer = player;
    const suffocating = ship.oxygenDeadlineTurn !== undefined;

    if (suffocating) {
      if (player.breachSeals <= 0) {
        entries.push(`${label(playerId)} tries to seal a hull breach, but no breach seal kits remain.`);
        return player;
      }

      nextPlayer = {
        ...player,
        breachSeals: player.breachSeals - 1
      };
      clearSuffocation(
        ship,
        entries,
        label(playerId),
        `Hull breach sealed (${nextPlayer.breachSeals} breach seal kit${nextPlayer.breachSeals === 1 ? "" : "s"} left). Cabin pressure stabilizes.`
      );
    }

    const previousHull = ship.hull;
    const patchAmount = 3;
    ship.hull = clamp(ship.hull + patchAmount, 0, ship.maxHull);
    entries.push(
      `${label(playerId)} patches hull plating from ${previousHull}/${ship.maxHull} to ${ship.hull}/${ship.maxHull}.`
    );
    return nextPlayer;
  }

  return player;
}

function applyElectronicCommand(
  playerId: PlayerId,
  attacker: Ship,
  defender: Ship,
  command: CombatCommand,
  entries: string[],
  label: (playerId: PlayerId) => string
) {
  if (command.type !== "jam") {
    return;
  }

  if (!isSystemOnline(attacker, "sensors")) {
    entries.push(`${label(playerId)} tries to jam enemy sensors, but their own sensors are offline.`);
    return;
  }

  const jamDamage = integrityPercent(attacker, "sensors") >= 0.75 ? 2 : 1;
  const { previousHp, lostCrew } = damageShipSystem(defender, "sensors", jamDamage);
  entries.push(
    `${label(playerId)} jams enemy sensors (${previousHp}/${defender.systems.sensors.maxHp} -> ${defender.systems.sensors.hp}/${defender.systems.sensors.maxHp}).`
  );
  const casualtyEntry = formatCrewCasualtyEntry(defender.systems.sensors.name, lostCrew);
  if (casualtyEntry) {
    entries.push(`${label(getOpponent(playerId))} ${casualtyEntry}`);
  }
}

function applyFireCommand(
  playerId: PlayerId,
  attacker: Ship,
  defender: Ship,
  command: CombatCommand,
  turn: number,
  entries: string[],
  label: (playerId: PlayerId) => string
) {
  if (command.type !== "fire") {
    return;
  }

  if (!isSystemOnline(attacker, "weapons")) {
    entries.push(`${label(playerId)} cannot fire because weapons are offline.`);
    return;
  }

  const targetSystem = command.targetSystem ?? DEFAULT_TARGET_SYSTEM;
  const roll = deterministicRoll(`${turn}:${playerId}:${targetSystem}:${defender.hull}`);
  const accuracy = clamp(
    72 +
      integrityPercent(attacker, "sensors") * 14 -
      integrityPercent(defender, "engines") * 12 +
      getCrewAccuracyBonus(attacker) -
      getCrewEvasionBonus(defender),
    35,
    92
  );

  if (roll > accuracy) {
    entries.push(`${label(playerId)} fires at ${defender.systems[targetSystem].name} and misses.`);
    return;
  }

  const weaponBonus = integrityPercent(attacker, "weapons") >= 0.8 ? 1 : 0;
  let hullDamage = 4 + weaponBonus;
  let systemDamage = 2 + weaponBonus;

  const critRoll = deterministicRoll(`${turn}:${playerId}:${targetSystem}:crit:${defender.hull}`);
  const critChance = getCriticalStrikeChance(attacker);
  const isCritical = critRoll < critChance;
  const punctureRoll = deterministicRoll(`${turn}:${playerId}:${targetSystem}:puncture:${defender.hull}`);
  const isHullPuncture = isCritical && punctureRoll < CRITICAL_PUNCTURE_CHANCE;

  if (isCritical && !isHullPuncture) {
    hullDamage += CRITICAL_STRIKE_HULL_BONUS;
    systemDamage += CRITICAL_STRIKE_SYSTEM_BONUS;
  }

  let hullDamageApplied = hullDamage;

  if (defender.shield > 0 && isSystemOnline(defender, "shields")) {
    const previousShield = defender.shield;
    defender.shield = Math.max(0, defender.shield - hullDamage);
    const shieldAbsorbed = previousShield - defender.shield;
    hullDamageApplied = 0;

    if (shieldAbsorbed > 0) {
      entries.push(
        `${label(getOpponent(playerId))}'s shields absorb ${shieldAbsorbed} damage (${defender.shield}/${defender.maxShield} remaining).`
      );
    }
  }

  defender.hull = clamp(defender.hull - hullDamageApplied, 0, defender.maxHull);
  const { previousHp: previousSystemHp, lostCrew } = damageShipSystem(defender, targetSystem, systemDamage);
  const casualtyEntry = formatCrewCasualtyEntry(defender.systems[targetSystem].name, lostCrew);
  const hullSummary =
    hullDamageApplied > 0 ? `${hullDamageApplied} hull and ${systemDamage} system damage` : `${systemDamage} system damage`;

  if (isHullPuncture) {
    beginSuffocation(defender, turn, entries);
    entries.push(
      `${label(playerId)} lands a ${HULL_PUNCTURE_LOG_MARKER}! ${hullSummary} (${previousSystemHp}/${defender.systems[targetSystem].maxHp} -> ${defender.systems[targetSystem].hp}/${defender.systems[targetSystem].maxHp}). Atmosphere vents into space.`
    );
  } else if (isCritical) {
    entries.push(
      `${label(playerId)} lands a ${CRITICAL_STRIKE_LOG_MARKER} on ${defender.systems[targetSystem].name}! ${hullSummary} (${previousSystemHp}/${defender.systems[targetSystem].maxHp} -> ${defender.systems[targetSystem].hp}/${defender.systems[targetSystem].maxHp}).`
    );
  } else {
    entries.push(
      `${label(playerId)} hits ${defender.systems[targetSystem].name} for ${hullSummary} (${previousSystemHp}/${defender.systems[targetSystem].maxHp} -> ${defender.systems[targetSystem].hp}/${defender.systems[targetSystem].maxHp}).`
    );
  }

  if (casualtyEntry) {
    entries.push(`${label(getOpponent(playerId))} ${casualtyEntry}`);
  }
}

function beginSuffocation(
  ship: Ship,
  turn: number,
  entries: string[],
  reason?: string
) {
  if (ship.hull <= 0 || ship.oxygenDeadlineTurn !== undefined) {
    return;
  }

  ship.oxygenDeadlineTurn = turn + SUFFOCATION_TURNS;

  if (reason) {
    entries.push(reason);
  }
}

function clearSuffocation(
  ship: Ship,
  entries: string[],
  label: string,
  message: string
) {
  if (ship.oxygenDeadlineTurn === undefined) {
    return;
  }

  ship.oxygenDeadlineTurn = undefined;
  entries.push(`${label} ${message}`);
}

function applySuffocationPressure(
  playerId: PlayerId,
  ship: Ship,
  turn: number,
  entries: string[],
  label: (playerId: PlayerId) => string
) {
  if (ship.hull <= 0) {
    return;
  }

  if (ship.systems.lifeSupport.hp <= 0 && ship.oxygenDeadlineTurn === undefined) {
    beginSuffocation(
      ship,
      turn,
      entries,
      `${label(playerId)} life support offline. Crew begins suffocating.`
    );
  }

  if (ship.oxygenDeadlineTurn === undefined) {
    return;
  }

  if (turn >= ship.oxygenDeadlineTurn) {
    ship.hull = 0;
    entries.push(`${label(playerId)} crew suffocates. The ship is lost.`);
    return;
  }

  entries.push(
    `${label(playerId)} crew suffocating — ${ship.oxygenDeadlineTurn - turn} turn(s) until loss.`
  );
}

function determineWinner(ships: Record<PlayerId, Ship>): PlayerId | undefined {
  const disabled = PLAYER_IDS.filter((playerId) => ships[playerId].hull <= 0);

  if (disabled.length === 1) {
    return getOpponent(disabled[0]);
  }

  return undefined;
}

function formatBattleVictoryMessage(
  winner: PlayerId,
  loser: PlayerId,
  ships: Record<PlayerId, Ship>,
  turnEntries: string[],
  label: (playerId: PlayerId) => string
): string {
  const winnerName = label(winner);
  const loserName = label(loser);
  const loserShip = ships[loser];
  const decisiveEntry = findDecisiveTurnEntry(loser, loserShip, turnEntries, label);

  if (decisiveEntry) {
    return `${winnerName} ${BATTLE_END_LOG_MARKER} — ${decisiveEntry}`;
  }

  if (loserShip.hull <= 0) {
    return `${winnerName} ${BATTLE_END_LOG_MARKER} — ${loserName}'s hull is breached and the ship is lost.`;
  }

  return `${winnerName} ${BATTLE_END_LOG_MARKER}.`;
}

function findDecisiveTurnEntry(
  loser: PlayerId,
  loserShip: Ship,
  turnEntries: string[],
  label: (playerId: PlayerId) => string
): string | undefined {
  const loserName = label(loser);
  const suffocationEntry = turnEntries.find((entry) => entry.includes(`${loserName} crew suffocates`));

  if (suffocationEntry) {
    return suffocationEntry;
  }

  if (loserShip.hull <= 0) {
    const hullHit = [...turnEntries]
      .reverse()
      .find(
        (entry) =>
          (entry.includes("hits") ||
            entry.includes(CRITICAL_STRIKE_LOG_MARKER) ||
            entry.includes(HULL_PUNCTURE_LOG_MARKER)) &&
          entry.includes(" hull")
      );

    if (hullHit) {
      return hullHit;
    }

    const lastHit = [...turnEntries]
      .reverse()
      .find(
        (entry) =>
          entry.includes("hits") ||
          entry.includes(CRITICAL_STRIKE_LOG_MARKER) ||
          entry.includes(HULL_PUNCTURE_LOG_MARKER)
      );

    if (lastHit) {
      return lastHit;
    }
  }

  return undefined;
}

function pickFirstCombatPlayer(room: RoomState): PlayerId {
  return deterministicRoll(`${room.code}:combat-start`) % 2 === 0 ? "captainA" : "captainB";
}

function bothRematchReady(room: RoomState): boolean {
  return PLAYER_IDS.every((playerId) => room.players[playerId]?.connected && room.players[playerId]?.rematchReady);
}

function cloneShip(ship: Ship): Ship {
  return {
    ...ship,
    crewAssignments: { ...ship.crewAssignments },
    systems: SYSTEM_DEFINITIONS.reduce(
      (acc, system) => {
        acc[system.id] = {
          ...ship.systems[system.id]
        };
        return acc;
      },
      {} as Record<SystemId, ShipSystemState>
    )
  };
}

function isSystemOnline(ship: Ship, systemId: SystemId): boolean {
  return ship.systems[systemId].hp > 0;
}

function integrityPercent(ship: Ship, systemId: SystemId): number {
  const system = ship.systems[systemId];
  return system.hp / system.maxHp;
}

function deterministicRoll(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 10000;
  }
  return hash % 100;
}

function playerLabel(room: RoomState, playerId: PlayerId): string {
  return room.players[playerId]?.name ?? (playerId === "captainA" ? "Captain A" : "Captain B");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

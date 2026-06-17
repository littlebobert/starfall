export type PlayerId = "captainA" | "captainB";

export type RoomPhase = "lobby" | "combat" | "finished";

export type ShipClassId = "hauler" | "skiff" | "cutter";

export type SystemId =
  | "reactor"
  | "engines"
  | "shields"
  | "weapons"
  | "sensors"
  | "lifeSupport";

export type CommandType = "fire" | "repair" | "brace" | "divert" | "jam" | "evasive" | "patch" | "redeploy";

export type DivertTarget = "shields" | "engines" | "weapons";

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
  crewTotal: number;
  crewAssignments: Record<SystemId, number>;
  systems: Record<SystemId, ShipSystemState>;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  connected: boolean;
  shipClassId: ShipClassId;
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
  divertTarget?: DivertTarget;
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
  getCrewLifeSupportMitigation,
  sanitizeCrewAssignments
} from "./crew";

export const SYSTEM_DEFINITIONS: ShipSystemDefinition[] = [
  {
    id: "reactor",
    name: "Reactor",
    maxHp: 6,
    description: "Critical power core. If it collapses, the ship is disabled."
  },
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

export const DEFAULT_COMMAND: CombatCommand = {
  type: "brace"
};

export const CRITICAL_STRIKE_LOG_MARKER = "CRITICAL STRIKE";

const CRITICAL_STRIKE_BASE_CHANCE = 8;
const CRITICAL_STRIKE_SENSOR_BONUS = 22;
const CRITICAL_STRIKE_WEAPON_BONUS = 12;
const CRITICAL_STRIKE_MAX_CHANCE = 42;
const CRITICAL_STRIKE_HULL_BONUS = 3;
const CRITICAL_STRIKE_SYSTEM_BONUS = 2;

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
    log: [...room.log, `${playerLabel(room, playerId)} selects the ${shipClass.name}.`].slice(-30)
  };
}

function shipClassForPlayer(room: RoomState, playerId: PlayerId): ShipClassId {
  return room.players[playerId]?.shipClassId ?? DEFAULT_SHIP_CLASS_ID;
}

function buildCombatShips(room: RoomState): Record<PlayerId, Ship> {
  return {
    captainA: createShip("captainA", shipClassForPlayer(room, "captainA")),
    captainB: createShip("captainB", shipClassForPlayer(room, "captainB"))
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

export function startCombat(room: RoomState): RoomState {
  if (!canStartCombat(room)) {
    return room;
  }

  return {
    ...room,
    phase: "combat",
    ships: buildCombatShips(room),
    turn: 1,
    activePlayer: "captainA",
    winner: undefined,
    log: [
      `${playerLabel(room, "captainA")} deploys a ${getShipClass(shipClassForPlayer(room, "captainA")).name}. ${playerLabel(room, "captainB")} deploys a ${getShipClass(shipClassForPlayer(room, "captainB")).name}.`,
      `Combat begins. ${playerLabel(room, "captainA")} has the first action.`
    ]
  };
}

export function canRematch(room: RoomState): boolean {
  return room.phase === "finished" && canStartCombat(room);
}

export function rematchCombat(room: RoomState): RoomState {
  if (!canRematch(room)) {
    return room;
  }

  const firstPlayer: PlayerId = room.winner ? getOpponent(room.winner) : "captainA";

  return {
    ...room,
    phase: "combat",
    ships: buildCombatShips(room),
    turn: 1,
    activePlayer: firstPlayer,
    winner: undefined,
    log: [
      ...room.log,
      "Both captains return to the field for a rematch.",
      `Combat begins. ${playerLabel(room, firstPlayer)} has the first action.`
    ].slice(-30)
  };
}

export function normalizeCommand(command: CombatCommand): CombatCommand {
  if (command.type === "fire") {
    return {
      type: "fire",
      targetSystem: command.targetSystem ?? "reactor"
    };
  }

  if (command.type === "repair") {
    return {
      type: "repair",
      repairSystem: command.repairSystem ?? "reactor"
    };
  }

  if (command.type === "divert") {
    return {
      type: "divert",
      divertTarget: command.divertTarget ?? "shields"
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

  if (normalizedCommand.type === "redeploy") {
    applyRedeployCommand(playerId, ships[playerId], normalizedCommand, entries, label);
  } else {
    applyPreparationCommand(playerId, ships[playerId], normalizedCommand, entries, label);
    applyElectronicCommand(playerId, ships[playerId], ships[opponent], normalizedCommand, entries, label);
    applyFireCommand(playerId, ships[playerId], ships[opponent], normalizedCommand, room.turn, entries, label);
  }

  for (const id of PLAYER_IDS) {
    applyLifeSupportPressure(id, ships[id], entries, label);
  }

  const winner = determineWinner(ships);
  const nextLog = [...room.log, ...entries].slice(-30);

  if (winner) {
    nextLog.push(`${label(winner)} wins the battle.`);
  }

  return {
    ...room,
    phase: winner ? "finished" : "combat",
    ships,
    turn: room.turn + 1,
    activePlayer: winner ? undefined : opponent,
    log: nextLog,
    winner
  };
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
  label: (playerId: PlayerId) => string
) {
  if (command.type === "repair") {
    const systemId = command.repairSystem ?? "reactor";
    const system = ship.systems[systemId];
    const repairAmount = systemId === "reactor" ? 1 : 2;
    const previousHp = system.hp;
    system.hp = clamp(system.hp + repairAmount, 0, system.maxHp);
    ship.hull = clamp(ship.hull + 1, 0, ship.maxHull);
    entries.push(
      `${label(playerId)} repairs ${system.name} from ${previousHp}/${system.maxHp} to ${system.hp}/${system.maxHp}.`
    );
    return;
  }

  if (command.type === "brace") {
    const shieldGain = isSystemOnline(ship, "shields") ? 2 : 1;
    ship.shield = clamp(ship.shield + shieldGain, 0, ship.maxShield);
    entries.push(`${label(playerId)} braces behind reinforced shields.`);
    return;
  }

  if (command.type === "divert") {
    applyDivert(playerId, ship, command.divertTarget ?? "shields", entries, label);
    return;
  }

  if (command.type === "evasive") {
    const previousEngines = ship.systems.engines.hp;
    ship.systems.engines.hp = clamp(ship.systems.engines.hp + 1, 0, ship.systems.engines.maxHp);
    ship.shield = clamp(ship.shield + 1, 0, ship.maxShield);
    entries.push(
      `${label(playerId)} takes evasive maneuvers, tuning engines from ${previousEngines}/${ship.systems.engines.maxHp} to ${ship.systems.engines.hp}/${ship.systems.engines.maxHp} and adding 1 shield.`
    );
    return;
  }

  if (command.type === "patch") {
    const previousHull = ship.hull;
    const reactorOnline = isSystemOnline(ship, "reactor");
    const patchAmount = reactorOnline ? 3 : 1;
    ship.hull = clamp(ship.hull + patchAmount, 0, ship.maxHull);
    entries.push(
      `${label(playerId)} patches hull plating from ${previousHull}/${ship.maxHull} to ${ship.hull}/${ship.maxHull}.`
    );
  }
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

function applyDivert(
  playerId: PlayerId,
  ship: Ship,
  divertTarget: DivertTarget,
  entries: string[],
  label: (playerId: PlayerId) => string
) {
  if (!isSystemOnline(ship, "reactor")) {
    entries.push(`${label(playerId)} tries to divert power, but the reactor is offline.`);
    return;
  }

  if (divertTarget === "shields") {
    ship.shield = clamp(ship.shield + 3, 0, ship.maxShield);
    entries.push(`${label(playerId)} diverts reactor power to shields.`);
    return;
  }

  if (divertTarget === "engines") {
    ship.systems.engines.hp = clamp(
      ship.systems.engines.hp + 1,
      0,
      ship.systems.engines.maxHp
    );
    entries.push(`${label(playerId)} floods the engines with emergency power.`);
    return;
  }

  ship.systems.weapons.hp = clamp(
    ship.systems.weapons.hp + 1,
    0,
    ship.systems.weapons.maxHp
  );
  entries.push(`${label(playerId)} reroutes power through the weapon capacitors.`);
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

  const targetSystem = command.targetSystem ?? "reactor";
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

  if (defender.shield > 0 && isSystemOnline(defender, "shields")) {
    const absorbed = Math.min(defender.shield, 3);
    defender.shield -= absorbed;
    hullDamage = Math.max(1, hullDamage - absorbed);
    systemDamage = Math.max(1, systemDamage - 1);
    entries.push(`${label(getOpponent(playerId))}'s shields absorb ${absorbed} damage.`);
  }

  const critRoll = deterministicRoll(`${turn}:${playerId}:${targetSystem}:crit:${defender.hull}`);
  const critChance = getCriticalStrikeChance(attacker);
  const isCritical = critRoll < critChance;

  if (isCritical) {
    hullDamage += CRITICAL_STRIKE_HULL_BONUS;
    systemDamage += CRITICAL_STRIKE_SYSTEM_BONUS;
  }

  defender.hull = clamp(defender.hull - hullDamage, 0, defender.maxHull);
  const { previousHp: previousSystemHp, lostCrew } = damageShipSystem(defender, targetSystem, systemDamage);
  const casualtyEntry = formatCrewCasualtyEntry(defender.systems[targetSystem].name, lostCrew);

  if (isCritical) {
    entries.push(
      `${label(playerId)} lands a ${CRITICAL_STRIKE_LOG_MARKER} on ${defender.systems[targetSystem].name}! ${hullDamage} hull and ${systemDamage} system damage (${previousSystemHp}/${defender.systems[targetSystem].maxHp} -> ${defender.systems[targetSystem].hp}/${defender.systems[targetSystem].maxHp}).`
    );
  } else {
    entries.push(
      `${label(playerId)} hits ${defender.systems[targetSystem].name} for ${hullDamage} hull and ${systemDamage} system damage (${previousSystemHp}/${defender.systems[targetSystem].maxHp} -> ${defender.systems[targetSystem].hp}/${defender.systems[targetSystem].maxHp}).`
    );
  }

  if (casualtyEntry) {
    entries.push(`${label(getOpponent(playerId))} ${casualtyEntry}`);
  }
}

function applyLifeSupportPressure(
  playerId: PlayerId,
  ship: Ship,
  entries: string[],
  label: (playerId: PlayerId) => string
) {
  if (ship.systems.lifeSupport.hp > 0 || ship.hull <= 0) {
    return;
  }

  ship.hull = clamp(ship.hull - Math.max(1, 2 - getCrewLifeSupportMitigation(ship)), 0, ship.maxHull);
  entries.push(`${label(playerId)} loses hull integrity as life support fails.`);
}

function determineWinner(ships: Record<PlayerId, Ship>): PlayerId | undefined {
  const disabled = PLAYER_IDS.filter((playerId) => {
    const ship = ships[playerId];
    return ship.hull <= 0 || ship.systems.reactor.hp <= 0 || ship.systems.lifeSupport.hp <= 0;
  });

  if (disabled.length === 1) {
    return getOpponent(disabled[0]);
  }

  return undefined;
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

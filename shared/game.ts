export type PlayerId = "captainA" | "captainB";

export type RoomPhase = "lobby" | "combat" | "finished";

export type SystemId =
  | "reactor"
  | "engines"
  | "shields"
  | "weapons"
  | "sensors"
  | "lifeSupport";

export type CommandType = "fire" | "repair" | "brace" | "divert" | "jam" | "evasive" | "patch";

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
  name: string;
  maxHull: number;
  hull: number;
  maxShield: number;
  shield: number;
  systems: Record<SystemId, ShipSystemState>;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  connected: boolean;
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
}

export interface RoomState {
  code: string;
  phase: RoomPhase;
  players: Partial<Record<PlayerId, PlayerState>>;
  spectators: Record<string, SpectatorState>;
  ships: Partial<Record<PlayerId, Ship>>;
  turn: number;
  pendingCommands: Partial<Record<PlayerId, CombatCommand>>;
  log: string[];
  chat: ChatMessage[];
  winner?: PlayerId;
}

export interface ClientRoomState extends Omit<RoomState, "pendingCommands"> {
  you?: PlayerId;
  spectatorId?: string;
  lockedIn: Record<PlayerId, boolean>;
}

export const PLAYER_IDS: PlayerId[] = ["captainA", "captainB"];

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

export function createRoom(code: string): RoomState {
  return {
    code,
    phase: "lobby",
    players: {},
    spectators: {},
    ships: {},
    turn: 1,
    pendingCommands: {},
    log: [`Room ${code} created. Waiting for captains.`],
    chat: []
  };
}

export function createStarterShip(owner: PlayerId): Ship {
  const systems = SYSTEM_DEFINITIONS.reduce(
    (acc, system) => {
      acc[system.id] = {
        ...system,
        hp: system.maxHp
      };
      return acc;
    },
    {} as Record<SystemId, ShipSystemState>
  );

  return {
    owner,
    name: owner === "captainA" ? "Rusted Hauler" : "Border Skiff",
    maxHull: 28,
    hull: 28,
    maxShield: 8,
    shield: 4,
    systems
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
    log: room.log,
    chat: room.chat,
    winner: room.winner,
    you,
    spectatorId,
    lockedIn: {
      captainA: Boolean(room.pendingCommands.captainA),
      captainB: Boolean(room.pendingCommands.captainB)
    }
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
    ships: {
      captainA: createStarterShip("captainA"),
      captainB: createStarterShip("captainB")
    },
    turn: 1,
    pendingCommands: {},
    log: [
      "Both captains have entered the sector.",
      "Combat begins. Pick a command and lock in."
    ]
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

  return DEFAULT_COMMAND;
}

export function resolveTurn(room: RoomState): RoomState {
  const captainA = room.ships.captainA;
  const captainB = room.ships.captainB;

  if (room.phase !== "combat" || !captainA || !captainB) {
    return room;
  }

  const ships: Record<PlayerId, Ship> = {
    captainA: cloneShip(captainA),
    captainB: cloneShip(captainB)
  };
  const commands: Record<PlayerId, CombatCommand> = {
    captainA: normalizeCommand(room.pendingCommands.captainA ?? DEFAULT_COMMAND),
    captainB: normalizeCommand(room.pendingCommands.captainB ?? DEFAULT_COMMAND)
  };
  const entries: string[] = [`Turn ${room.turn} resolves.`];

  for (const playerId of PLAYER_IDS) {
    applyPreparationCommand(playerId, ships[playerId], commands[playerId], entries);
  }

  for (const playerId of PLAYER_IDS) {
    applyElectronicCommand(playerId, ships[playerId], ships[getOpponent(playerId)], commands[playerId], entries);
  }

  for (const playerId of PLAYER_IDS) {
    applyFireCommand(
      playerId,
      ships[playerId],
      ships[getOpponent(playerId)],
      commands[playerId],
      room.turn,
      entries
    );
  }

  for (const playerId of PLAYER_IDS) {
    applyLifeSupportPressure(playerId, ships[playerId], entries);
  }

  const winner = determineWinner(ships);
  const nextLog = [...room.log, ...entries].slice(-30);

  if (winner) {
    nextLog.push(`${labelFor(winner)} wins the battle.`);
  }

  return {
    ...room,
    phase: winner ? "finished" : "combat",
    ships,
    turn: winner ? room.turn : room.turn + 1,
    pendingCommands: {},
    log: nextLog,
    winner
  };
}

function applyPreparationCommand(
  playerId: PlayerId,
  ship: Ship,
  command: CombatCommand,
  entries: string[]
) {
  if (command.type === "repair") {
    const systemId = command.repairSystem ?? "reactor";
    const system = ship.systems[systemId];
    const repairAmount = systemId === "reactor" ? 1 : 2;
    const previousHp = system.hp;
    system.hp = clamp(system.hp + repairAmount, 0, system.maxHp);
    ship.hull = clamp(ship.hull + 1, 0, ship.maxHull);
    entries.push(
      `${labelFor(playerId)} repairs ${system.name} from ${previousHp}/${system.maxHp} to ${system.hp}/${system.maxHp}.`
    );
    return;
  }

  if (command.type === "brace") {
    const shieldGain = isSystemOnline(ship, "shields") ? 2 : 1;
    ship.shield = clamp(ship.shield + shieldGain, 0, ship.maxShield);
    entries.push(`${labelFor(playerId)} braces behind reinforced shields.`);
    return;
  }

  if (command.type === "divert") {
    applyDivert(playerId, ship, command.divertTarget ?? "shields", entries);
    return;
  }

  if (command.type === "evasive") {
    const previousEngines = ship.systems.engines.hp;
    ship.systems.engines.hp = clamp(ship.systems.engines.hp + 1, 0, ship.systems.engines.maxHp);
    ship.shield = clamp(ship.shield + 1, 0, ship.maxShield);
    entries.push(
      `${labelFor(playerId)} takes evasive maneuvers, tuning engines from ${previousEngines}/${ship.systems.engines.maxHp} to ${ship.systems.engines.hp}/${ship.systems.engines.maxHp} and adding 1 shield.`
    );
    return;
  }

  if (command.type === "patch") {
    const previousHull = ship.hull;
    const reactorOnline = isSystemOnline(ship, "reactor");
    const patchAmount = reactorOnline ? 3 : 1;
    ship.hull = clamp(ship.hull + patchAmount, 0, ship.maxHull);
    entries.push(
      `${labelFor(playerId)} patches hull plating from ${previousHull}/${ship.maxHull} to ${ship.hull}/${ship.maxHull}.`
    );
  }
}

function applyElectronicCommand(
  playerId: PlayerId,
  attacker: Ship,
  defender: Ship,
  command: CombatCommand,
  entries: string[]
) {
  if (command.type !== "jam") {
    return;
  }

  if (!isSystemOnline(attacker, "sensors")) {
    entries.push(`${labelFor(playerId)} tries to jam enemy sensors, but their own sensors are offline.`);
    return;
  }

  const previousSensors = defender.systems.sensors.hp;
  const jamDamage = integrityPercent(attacker, "sensors") >= 0.75 ? 2 : 1;
  defender.systems.sensors.hp = clamp(
    defender.systems.sensors.hp - jamDamage,
    0,
    defender.systems.sensors.maxHp
  );
  entries.push(
    `${labelFor(playerId)} jams enemy sensors (${previousSensors}/${defender.systems.sensors.maxHp} -> ${defender.systems.sensors.hp}/${defender.systems.sensors.maxHp}).`
  );
}

function applyDivert(
  playerId: PlayerId,
  ship: Ship,
  divertTarget: DivertTarget,
  entries: string[]
) {
  if (!isSystemOnline(ship, "reactor")) {
    entries.push(`${labelFor(playerId)} tries to divert power, but the reactor is offline.`);
    return;
  }

  if (divertTarget === "shields") {
    ship.shield = clamp(ship.shield + 3, 0, ship.maxShield);
    entries.push(`${labelFor(playerId)} diverts reactor power to shields.`);
    return;
  }

  if (divertTarget === "engines") {
    ship.systems.engines.hp = clamp(
      ship.systems.engines.hp + 1,
      0,
      ship.systems.engines.maxHp
    );
    entries.push(`${labelFor(playerId)} floods the engines with emergency power.`);
    return;
  }

  ship.systems.weapons.hp = clamp(
    ship.systems.weapons.hp + 1,
    0,
    ship.systems.weapons.maxHp
  );
  entries.push(`${labelFor(playerId)} reroutes power through the weapon capacitors.`);
}

function applyFireCommand(
  playerId: PlayerId,
  attacker: Ship,
  defender: Ship,
  command: CombatCommand,
  turn: number,
  entries: string[]
) {
  if (command.type !== "fire") {
    return;
  }

  if (!isSystemOnline(attacker, "weapons")) {
    entries.push(`${labelFor(playerId)} cannot fire because weapons are offline.`);
    return;
  }

  const targetSystem = command.targetSystem ?? "reactor";
  const roll = deterministicRoll(`${turn}:${playerId}:${targetSystem}:${defender.hull}`);
  const accuracy = clamp(
    72 + integrityPercent(attacker, "sensors") * 14 - integrityPercent(defender, "engines") * 12,
    35,
    92
  );

  if (roll > accuracy) {
    entries.push(`${labelFor(playerId)} fires at ${defender.systems[targetSystem].name} and misses.`);
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
    entries.push(`${labelFor(getOpponent(playerId))}'s shields absorb ${absorbed} damage.`);
  }

  const previousSystemHp = defender.systems[targetSystem].hp;
  defender.hull = clamp(defender.hull - hullDamage, 0, defender.maxHull);
  defender.systems[targetSystem].hp = clamp(
    defender.systems[targetSystem].hp - systemDamage,
    0,
    defender.systems[targetSystem].maxHp
  );
  entries.push(
    `${labelFor(playerId)} hits ${defender.systems[targetSystem].name} for ${hullDamage} hull and ${systemDamage} system damage (${previousSystemHp}/${defender.systems[targetSystem].maxHp} -> ${defender.systems[targetSystem].hp}/${defender.systems[targetSystem].maxHp}).`
  );
}

function applyLifeSupportPressure(playerId: PlayerId, ship: Ship, entries: string[]) {
  if (ship.systems.lifeSupport.hp > 0 || ship.hull <= 0) {
    return;
  }

  ship.hull = clamp(ship.hull - 2, 0, ship.maxHull);
  entries.push(`${labelFor(playerId)} loses hull integrity as life support fails.`);
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

function labelFor(playerId: PlayerId): string {
  return playerId === "captainA" ? "Captain A" : "Captain B";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

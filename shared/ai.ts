import {
  CombatCommand,
  DEFAULT_TARGET_SYSTEM,
  getOpponent,
  RoomState,
  Ship,
  ShipClassId,
  PlayerId,
  SYSTEM_DEFINITIONS,
  SystemId
} from "./game";

const AI_SHIP_CHOICES: ShipClassId[] = ["hauler", "skiff", "cutter"];

export const AI_PLAYER_ID: PlayerId = "captainB";
export const AI_CAPTAIN_NAME = "Auto-Captain";

export function chooseAiShipClass(roomCode: string): ShipClassId {
  return AI_SHIP_CHOICES[deterministicRoll(`${roomCode}:ai-ship`) % AI_SHIP_CHOICES.length];
}

export function chooseAiCrewDeployment(ship: Ship): Record<SystemId, number> {
  return { ...ship.crewAssignments };
}

export function chooseAiCommand(room: RoomState, playerId: PlayerId = AI_PLAYER_ID): CombatCommand {
  const aiShip = room.ships[playerId];
  const opponentId = getOpponent(playerId);
  const opponentShip = room.ships[opponentId];
  const aiPlayer = room.players[playerId];

  if (!aiShip || !opponentShip) {
    return { type: "brace" };
  }

  if (aiShip.oxygenDeadlineTurn !== undefined && (aiPlayer?.breachSeals ?? 0) > 0) {
    return { type: "patch" };
  }

  if (aiShip.systems.lifeSupport.hp <= 0) {
    return { type: "repair", repairSystem: "lifeSupport" };
  }

  if (aiShip.hull <= Math.ceil(aiShip.maxHull * 0.35)) {
    return { type: "patch" };
  }

  if (aiShip.systems.weapons.hp <= 0) {
    return { type: "repair", repairSystem: "weapons" };
  }

  if (aiShip.shield <= Math.floor(aiShip.maxShield * 0.25) && (aiPlayer?.shieldBraces ?? 0) > 0) {
    return { type: "brace" };
  }

  const shouldJam =
    aiShip.systems.sensors.hp > 0 &&
    opponentShip.systems.sensors.hp >= Math.ceil(opponentShip.systems.sensors.maxHp * 0.5) &&
    deterministicRoll(`${room.code}:${room.turn}:ai-jam`) < 35;

  if (shouldJam) {
    return { type: "jam" };
  }

  return { type: "fire", targetSystem: chooseAiTargetSystem(opponentShip) };
}

function chooseAiTargetSystem(opponentShip: Ship): SystemId {
  const priority: SystemId[] = ["weapons", "shields", "lifeSupport"];
  const priorityTarget = priority.find((systemId) => opponentShip.systems[systemId].hp > 0);

  if (priorityTarget) {
    return priorityTarget;
  }

  return (
    SYSTEM_DEFINITIONS
      .map((system) => opponentShip.systems[system.id])
      .filter((system) => system.hp > 0)
      .sort((left, right) => left.hp / left.maxHp - right.hp / right.maxHp)[0]?.id ?? DEFAULT_TARGET_SYSTEM
  );
}

function deterministicRoll(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 10000;
  }
  return hash % 100;
}

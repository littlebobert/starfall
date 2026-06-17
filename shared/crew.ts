import { PlayerId, Ship, ShipClassId, SYSTEM_DEFINITIONS, SystemId } from "./game";

export type CrewAssignments = Record<SystemId, number>;

export const MAX_CREW_PER_STATION = 3;

export const CREW_TOTAL_BY_CLASS: Record<ShipClassId, number> = {
  hauler: 5,
  skiff: 3,
  cutter: 4
};

export const DEFAULT_CREW_ASSIGNMENTS: Record<ShipClassId, CrewAssignments> = {
  hauler: {
    reactor: 1,
    engines: 0,
    shields: 2,
    weapons: 1,
    sensors: 0,
    lifeSupport: 1
  },
  skiff: {
    reactor: 0,
    engines: 0,
    shields: 0,
    weapons: 2,
    sensors: 1,
    lifeSupport: 0
  },
  cutter: {
    reactor: 1,
    engines: 0,
    shields: 1,
    weapons: 0,
    sensors: 2,
    lifeSupport: 0
  }
};

export function createCrewAssignments(classId: ShipClassId): CrewAssignments {
  return { ...DEFAULT_CREW_ASSIGNMENTS[classId] };
}

export function getCrewTotal(classId: ShipClassId): number {
  return CREW_TOTAL_BY_CLASS[classId];
}

export function getCrewAtStation(ship: Ship, systemId: SystemId): number {
  return ship.crewAssignments[systemId] ?? 0;
}

export function getAssignedCrewCount(ship: Ship): number {
  return getAssignedCrewCountFromAssignments(ship.crewAssignments);
}

export function getAssignedCrewCountFromAssignments(assignments: CrewAssignments): number {
  return SYSTEM_DEFINITIONS.reduce((total, system) => total + (assignments[system.id] ?? 0), 0);
}

export function crewAssignmentsEqual(left: CrewAssignments, right: CrewAssignments): boolean {
  return SYSTEM_DEFINITIONS.every((system) => left[system.id] === right[system.id]);
}

export function sanitizeCrewAssignments(
  ship: Ship,
  assignments?: Partial<Record<SystemId, number>>
): CrewAssignments | undefined {
  if (!assignments) {
    return undefined;
  }

  const normalized = {} as CrewAssignments;

  for (const system of SYSTEM_DEFINITIONS) {
    const value = assignments[system.id];
    if (value === undefined || !Number.isInteger(value) || value < 0 || value > MAX_CREW_PER_STATION) {
      return undefined;
    }

    normalized[system.id] = value;
  }

  if (getAssignedCrewCountFromAssignments(normalized) !== ship.crewTotal) {
    return undefined;
  }

  return normalized;
}

export function formatCrewDeployment(assignments: CrewAssignments): string {
  return SYSTEM_DEFINITIONS.filter((system) => assignments[system.id] > 0)
    .map((system) => `${system.name} ${assignments[system.id]}`)
    .join(", ");
}

export interface SystemDamageResult {
  previousHp: number;
  lostCrew: number;
}

export function damageShipSystem(ship: Ship, systemId: SystemId, damage: number): SystemDamageResult {
  const system = ship.systems[systemId];
  const previousHp = system.hp;
  system.hp = clamp(system.hp - damage, 0, system.maxHp);

  let lostCrew = 0;
  if (previousHp > 0 && system.hp === 0) {
    lostCrew = getCrewAtStation(ship, systemId);
    if (lostCrew > 0) {
      ship.crewAssignments = {
        ...ship.crewAssignments,
        [systemId]: 0
      };
      ship.crewTotal = Math.max(0, ship.crewTotal - lostCrew);
    }
  }

  return { previousHp, lostCrew };
}

export function formatCrewCasualtyEntry(systemName: string, lostCrew: number): string | undefined {
  if (lostCrew <= 0) {
    return undefined;
  }

  if (lostCrew === 1) {
    return `1 crew member is lost when ${systemName} goes offline.`;
  }

  return `${lostCrew} crew members are lost when ${systemName} goes offline.`;
}

export function getCrewAccuracyBonus(ship: Ship): number {
  if (!isSystemOnline(ship, "weapons")) {
    return 0;
  }

  return getCrewAtStation(ship, "weapons") * 3;
}

export function getCrewCritBonus(ship: Ship): number {
  if (!isSystemOnline(ship, "sensors")) {
    return 0;
  }

  return getCrewAtStation(ship, "sensors") * 3;
}

export function getCrewEvasionBonus(ship: Ship): number {
  if (!isSystemOnline(ship, "engines")) {
    return 0;
  }

  return getCrewAtStation(ship, "engines") * 2;
}

export function getCrewLifeSupportMitigation(ship: Ship): number {
  if (ship.systems.lifeSupport.hp > 0) {
    return 0;
  }

  return getCrewAtStation(ship, "lifeSupport") >= 1 ? 1 : 0;
}

export function applyCrewUpkeep(
  playerId: PlayerId,
  ship: Ship,
  entries: string[],
  label: (id: PlayerId) => string
) {
  const effects: string[] = [];

  const shieldCrew = getCrewAtStation(ship, "shields");
  if (shieldCrew > 0 && isSystemOnline(ship, "shields")) {
    const previousShield = ship.shield;
    const gain = Math.min(shieldCrew, 2);
    ship.shield = clamp(ship.shield + gain, 0, ship.maxShield);

    if (ship.shield > previousShield) {
      effects.push(`+${ship.shield - previousShield} shield`);
    }
  }

  const reactorCrew = getCrewAtStation(ship, "reactor");
  if (reactorCrew > 0 && isSystemOnline(ship, "reactor")) {
    const systemId = findMostDamagedSystem(ship);

    if (systemId) {
      const system = ship.systems[systemId];
      const previousHp = system.hp;
      system.hp = clamp(system.hp + 1, 0, system.maxHp);

      if (system.hp > previousHp) {
        effects.push(`+1 ${system.name}`);
      }
    }
  }

  if (effects.length > 0) {
    entries.push(`${label(playerId)}'s crew maintains ${effects.join(", ")}.`);
  }
}

function findMostDamagedSystem(ship: Ship): SystemId | undefined {
  let selected: SystemId | undefined;
  let lowestRatio = 1;

  for (const systemId of Object.keys(ship.systems) as SystemId[]) {
    const system = ship.systems[systemId];
    if (system.hp >= system.maxHp) {
      continue;
    }

    const ratio = system.hp / system.maxHp;
    if (ratio < lowestRatio) {
      lowestRatio = ratio;
      selected = systemId;
    }
  }

  return selected;
}

function isSystemOnline(ship: Ship, systemId: SystemId): boolean {
  return ship.systems[systemId].hp > 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

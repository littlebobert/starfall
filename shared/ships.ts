import {
  PlayerId,
  Ship,
  ShipClassId,
  SYSTEM_DEFINITIONS,
  SystemId,
  type ShipSystemState
} from "./game";
import { createCrewAssignments, getCrewTotal } from "./crew";

export interface ShipClassDefinition {
  id: ShipClassId;
  name: string;
  tagline: string;
  maxHull: number;
  maxShield: number;
  startingShield: number;
  systems: Partial<Record<SystemId, number>>;
}

export const DEFAULT_SHIP_CLASS_ID: ShipClassId = "hauler";

export const SHIP_CLASSES: ShipClassDefinition[] = [
  {
    id: "hauler",
    name: "Rusted Hauler",
    tagline: "Heavy shields and thick hull. Outlast the fight.",
    maxHull: 32,
    maxShield: 10,
    startingShield: 5,
    systems: {
      shields: 6,
      weapons: 4
    }
  },
  {
    id: "skiff",
    name: "Border Skiff",
    tagline: "Glass cannon with sharp sensors. Strike first, strike hard.",
    maxHull: 24,
    maxShield: 6,
    startingShield: 2,
    systems: {
      weapons: 6,
      sensors: 5
    }
  },
  {
    id: "cutter",
    name: "Survey Cutter",
    tagline: "Superior targeting and jamming. Control the battlefield.",
    maxHull: 26,
    maxShield: 7,
    startingShield: 3,
    systems: {
      sensors: 6,
      engines: 4
    }
  }
];

const SHIP_CLASS_BY_ID = Object.fromEntries(SHIP_CLASSES.map((shipClass) => [shipClass.id, shipClass])) as Record<
  ShipClassId,
  ShipClassDefinition
>;

export function isShipClassId(value: string): value is ShipClassId {
  return value in SHIP_CLASS_BY_ID;
}

export function getShipClass(classId: ShipClassId): ShipClassDefinition {
  return SHIP_CLASS_BY_ID[classId];
}

export function createShip(owner: PlayerId, classId: ShipClassId = DEFAULT_SHIP_CLASS_ID): Ship {
  const shipClass = getShipClass(classId);
  const systems = SYSTEM_DEFINITIONS.reduce(
    (acc, system) => {
      acc[system.id] = {
        ...system,
        maxHp: shipClass.systems[system.id] ?? system.maxHp,
        hp: shipClass.systems[system.id] ?? system.maxHp
      };
      return acc;
    },
    {} as Record<SystemId, ShipSystemState>
  );

  return {
    owner,
    classId,
    name: shipClass.name,
    maxHull: shipClass.maxHull,
    hull: shipClass.maxHull,
    maxShield: shipClass.maxShield,
    shield: shipClass.startingShield,
    crewTotal: getCrewTotal(classId),
    crewAssignments: createCrewAssignments(classId),
    systems
  };
}

export function formatShipClassSummary(classId: ShipClassId): string {
  const shipClass = getShipClass(classId);
  const highlights = Object.entries(shipClass.systems)
    .map(([systemId, maxHp]) => {
      const base = SYSTEM_DEFINITIONS.find((system) => system.id === systemId)?.maxHp;
      if (!base || maxHp === base) {
        return undefined;
      }

      const label = SYSTEM_DEFINITIONS.find((system) => system.id === systemId)?.name ?? systemId;
      return `${label} ${maxHp}`;
    })
    .filter(Boolean);

  const stats = [`${shipClass.maxHull} hull`, `${shipClass.maxShield} shields`, `${getCrewTotal(classId)} crew`];
  if (highlights.length > 0) {
    stats.push(highlights.join(", "));
  }

  return stats.join(" · ");
}

import { Ship, SYSTEM_DEFINITIONS, SystemId } from "./game";

export const MAX_UPGRADE_LEVEL = 3;
export const MIN_UPGRADE_LEVEL = 1;

export type SystemUpgrades = Record<SystemId, number>;

export interface VictoryCreditsBreakdown {
  base: number;
  hullBonus: number;
  systemsBonus: number;
  speedBonus: number;
  shieldBonus: number;
  crewBonus: number;
  total: number;
}

const UPGRADE_COST_BY_LEVEL: Record<number, number> = {
  1: 4,
  2: 7
};

export function createDefaultSystemUpgrades(): SystemUpgrades {
  return SYSTEM_DEFINITIONS.reduce(
    (acc, system) => {
      acc[system.id] = MIN_UPGRADE_LEVEL;
      return acc;
    },
    {} as SystemUpgrades
  );
}

export function normalizeSystemUpgrades(upgrades?: Partial<SystemUpgrades>): SystemUpgrades {
  const defaults = createDefaultSystemUpgrades();

  if (!upgrades) {
    return defaults;
  }

  return SYSTEM_DEFINITIONS.reduce(
    (acc, system) => {
      const level = upgrades[system.id] ?? MIN_UPGRADE_LEVEL;
      acc[system.id] = Math.min(MAX_UPGRADE_LEVEL, Math.max(MIN_UPGRADE_LEVEL, level));
      return acc;
    },
    {} as SystemUpgrades
  );
}

export function getUpgradeCost(currentLevel: number): number | undefined {
  if (currentLevel < MIN_UPGRADE_LEVEL || currentLevel >= MAX_UPGRADE_LEVEL) {
    return undefined;
  }

  return UPGRADE_COST_BY_LEVEL[currentLevel];
}

export function getUpgradeHpBonus(level: number): number {
  return Math.max(0, level - MIN_UPGRADE_LEVEL);
}

export function applySystemUpgrades(ship: Ship, upgrades?: Partial<SystemUpgrades>): Ship {
  const normalized = normalizeSystemUpgrades(upgrades);
  const systems = SYSTEM_DEFINITIONS.reduce(
    (acc, system) => {
      const current = ship.systems[system.id];
      const bonusHp = getUpgradeHpBonus(normalized[system.id]);
      const maxHp = current.maxHp + bonusHp;

      acc[system.id] = {
        ...current,
        maxHp,
        hp: maxHp
      };
      return acc;
    },
    {} as Ship["systems"]
  );

  return {
    ...ship,
    systems
  };
}

function countOnlineSystems(ship: Ship): number {
  return SYSTEM_DEFINITIONS.filter((system) => ship.systems[system.id].hp > 0).length;
}

export function calculateWinnerCredits(ship: Ship, turn: number): VictoryCreditsBreakdown {
  const hullRatio = ship.maxHull > 0 ? ship.hull / ship.maxHull : 0;
  const onlineSystems = countOnlineSystems(ship);
  const base = 5;
  const hullBonus = Math.round(hullRatio * 8);
  const systemsBonus = onlineSystems;
  const speedBonus = turn <= 5 ? 5 : turn <= 8 ? 3 : turn <= 12 ? 1 : 0;
  const shieldBonus =
    ship.shield > 0 && ship.systems.shields.hp > 0 ? 3 : 0;
  const crewBonus = Math.min(4, Math.floor(ship.crewTotal / 3));
  const total = Math.min(30, Math.max(8, base + hullBonus + systemsBonus + speedBonus + shieldBonus + crewBonus));

  return {
    base,
    hullBonus,
    systemsBonus,
    speedBonus,
    shieldBonus,
    crewBonus,
    total
  };
}

export function calculateLoserCredits(turn: number): number {
  return Math.min(8, 2 + Math.floor(turn / 3));
}

export function formatVictoryCreditsSummary(
  playerName: string,
  breakdown: VictoryCreditsBreakdown
): string {
  const parts = [
    `${breakdown.base} base`,
    `${breakdown.hullBonus} hull`,
    `${breakdown.systemsBonus} systems online`,
    `${breakdown.speedBonus} speed`,
    `${breakdown.shieldBonus} shields`,
    `${breakdown.crewBonus} crew`
  ];

  return `${playerName} earns ${breakdown.total} credits (${parts.join(", ")}).`;
}

export function formatLoserCreditsSummary(playerName: string, credits: number): string {
  return `${playerName} salvages ${credits} credits from the wreckage.`;
}

export function formatUpgradePurchase(
  playerName: string,
  systemName: string,
  nextLevel: number,
  cost: number
): string {
  return `${playerName} upgrades ${systemName} to level ${nextLevel} for ${cost} credits.`;
}

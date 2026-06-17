export type ConsumableId = "shieldBrace" | "breachSeal";

interface ConsumableStock {
  shieldBraces?: number;
  breachSeals?: number;
  credits?: number;
}

export interface ConsumableDefinition {
  id: ConsumableId;
  name: string;
  description: string;
  cost: number;
}

export const STARTING_SHIELD_BRACES = 1;
export const STARTING_BREACH_SEALS = 1;
export const MAX_CONSUMABLE_STOCK = 5;

export const CONSUMABLES: ConsumableDefinition[] = [
  {
    id: "shieldBrace",
    name: "Shield brace",
    description: "Emergency shield reinforcement. Required to use Brace shields in combat.",
    cost: 3
  },
  {
    id: "breachSeal",
    name: "Breach seal kit",
    description: "Seals a hull puncture and stops suffocation. Required for emergency patch while atmosphere is venting.",
    cost: 4
  }
];

const CONSUMABLE_BY_ID = Object.fromEntries(CONSUMABLES.map((item) => [item.id, item])) as Record<
  ConsumableId,
  ConsumableDefinition
>;

export function isConsumableId(value: string): value is ConsumableId {
  return value in CONSUMABLE_BY_ID;
}

export function getConsumableDefinition(id: ConsumableId): ConsumableDefinition {
  return CONSUMABLE_BY_ID[id];
}

export function createDefaultConsumables(): { shieldBraces: number; breachSeals: number } {
  return {
    shieldBraces: STARTING_SHIELD_BRACES,
    breachSeals: STARTING_BREACH_SEALS
  };
}

export function normalizeConsumables(player: ConsumableStock): { shieldBraces: number; breachSeals: number } {
  return {
    shieldBraces: Math.min(MAX_CONSUMABLE_STOCK, Math.max(0, player.shieldBraces ?? STARTING_SHIELD_BRACES)),
    breachSeals: Math.min(MAX_CONSUMABLE_STOCK, Math.max(0, player.breachSeals ?? STARTING_BREACH_SEALS))
  };
}

export function getConsumableStock(player: ConsumableStock, id: ConsumableId): number {
  const normalized = normalizeConsumables(player);
  return id === "shieldBrace" ? normalized.shieldBraces : normalized.breachSeals;
}

export function canPurchaseConsumable(player: ConsumableStock, id: ConsumableId): boolean {
  const item = getConsumableDefinition(id);
  return (player.credits ?? 0) >= item.cost && getConsumableStock(player, id) < MAX_CONSUMABLE_STOCK;
}

export function formatConsumablePurchase(
  playerName: string,
  itemName: string,
  stock: number,
  cost: number
): string {
  return `${playerName} buys a ${itemName} for ${cost} credits (${stock} in stock).`;
}

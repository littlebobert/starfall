import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createEmptyPlayerStats,
  PlayerStats,
  SessionMatchResult
} from "../shared/playerStats";

interface StatsStore {
  players: Record<string, PlayerStats>;
}

const statsFile = path.join(process.cwd(), "data", "player-stats.json");

function loadStore(): StatsStore {
  try {
    const raw = readFileSync(statsFile, "utf8");
    const parsed = JSON.parse(raw) as StatsStore;

    if (!parsed.players || typeof parsed.players !== "object") {
      return { players: {} };
    }

    return parsed;
  } catch {
    return { players: {} };
  }
}

function saveStore(store: StatsStore) {
  mkdirSync(path.dirname(statsFile), { recursive: true });
  writeFileSync(statsFile, JSON.stringify(store, null, 2));
}

function upsertPlayer(store: StatsStore, deviceId: string, lastName?: string): PlayerStats {
  const existing = store.players[deviceId] ?? createEmptyPlayerStats(deviceId, lastName);
  const nextStats: PlayerStats = {
    ...existing,
    lastName: lastName ?? existing.lastName,
    updatedAt: Date.now()
  };
  store.players[deviceId] = nextStats;
  return nextStats;
}

export function getPlayerStats(deviceId: string, lastName?: string): PlayerStats {
  const store = loadStore();
  const stats = upsertPlayer(store, deviceId, lastName);
  saveStore(store);
  return stats;
}

export function recordGameResult(
  winnerDeviceId: string,
  loserDeviceId: string,
  winnerName: string,
  loserName: string
): { winner: PlayerStats; loser: PlayerStats } {
  const store = loadStore();
  const winner = upsertPlayer(store, winnerDeviceId, winnerName);
  const loser = upsertPlayer(store, loserDeviceId, loserName);

  winner.gamesPlayed += 1;
  winner.gamesWon += 1;
  loser.gamesPlayed += 1;
  winner.updatedAt = Date.now();
  loser.updatedAt = Date.now();

  store.players[winnerDeviceId] = winner;
  store.players[loserDeviceId] = loser;
  saveStore(store);

  return { winner, loser };
}

export function recordMatchResult(match: SessionMatchResult): { winner: PlayerStats; loser: PlayerStats } {
  const store = loadStore();
  const winner = upsertPlayer(store, match.winnerDeviceId, match.winnerName);
  const loser = upsertPlayer(store, match.loserDeviceId, match.loserName);

  winner.matchesPlayed += 1;
  winner.matchesWon += 1;
  loser.matchesPlayed += 1;
  winner.updatedAt = Date.now();
  loser.updatedAt = Date.now();

  store.players[match.winnerDeviceId] = winner;
  store.players[match.loserDeviceId] = loser;
  saveStore(store);

  return { winner, loser };
}

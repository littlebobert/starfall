import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createEmptyPlayerStats,
  PlayerStats,
  SessionMatchResult
} from "../shared/playerStats";
import { getPool, hasDatabase } from "./db";

interface StatsStore {
  players: Record<string, PlayerStats>;
}

interface PlayerStatsRow {
  device_id: string;
  games_played: number;
  games_won: number;
  matches_played: number;
  matches_won: number;
  last_name: string | null;
  updated_at: number;
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

function upsertPlayerInStore(store: StatsStore, deviceId: string, lastName?: string): PlayerStats {
  const existing = store.players[deviceId] ?? createEmptyPlayerStats(deviceId, lastName);
  const nextStats: PlayerStats = {
    ...existing,
    lastName: lastName ?? existing.lastName,
    updatedAt: Date.now()
  };
  store.players[deviceId] = nextStats;
  return nextStats;
}

function rowToPlayerStats(row: PlayerStatsRow): PlayerStats {
  return {
    deviceId: row.device_id,
    gamesPlayed: row.games_played,
    gamesWon: row.games_won,
    matchesPlayed: row.matches_played,
    matchesWon: row.matches_won,
    lastName: row.last_name ?? undefined,
    updatedAt: Number(row.updated_at)
  };
}

async function savePlayerStats(stats: PlayerStats): Promise<PlayerStats> {
  const pool = getPool();

  await pool.query(
    `INSERT INTO player_stats (
       device_id, games_played, games_won, matches_played, matches_won, last_name, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (device_id) DO UPDATE SET
       games_played = EXCLUDED.games_played,
       games_won = EXCLUDED.games_won,
       matches_played = EXCLUDED.matches_played,
       matches_won = EXCLUDED.matches_won,
       last_name = EXCLUDED.last_name,
       updated_at = EXCLUDED.updated_at`,
    [
      stats.deviceId,
      stats.gamesPlayed,
      stats.gamesWon,
      stats.matchesPlayed,
      stats.matchesWon,
      stats.lastName ?? null,
      stats.updatedAt
    ]
  );

  return stats;
}

async function getPlayerStatsFromDatabase(deviceId: string, lastName?: string): Promise<PlayerStats> {
  const pool = getPool();
  const result = await pool.query<PlayerStatsRow>(
    `SELECT device_id, games_played, games_won, matches_played, matches_won, last_name, updated_at
     FROM player_stats
     WHERE device_id = $1`,
    [deviceId]
  );

  if (result.rows.length === 0) {
    return savePlayerStats(createEmptyPlayerStats(deviceId, lastName));
  }

  const existing = rowToPlayerStats(result.rows[0]);

  if (!lastName || lastName === existing.lastName) {
    return existing;
  }

  return savePlayerStats({
    ...existing,
    lastName,
    updatedAt: Date.now()
  });
}

function getPlayerStatsFromFile(deviceId: string, lastName?: string): PlayerStats {
  const store = loadStore();
  const stats = upsertPlayerInStore(store, deviceId, lastName);
  saveStore(store);
  return stats;
}

export async function getPlayerStats(deviceId: string, lastName?: string): Promise<PlayerStats> {
  if (hasDatabase()) {
    return getPlayerStatsFromDatabase(deviceId, lastName);
  }

  return getPlayerStatsFromFile(deviceId, lastName);
}

export async function recordGameResult(
  winnerDeviceId: string,
  loserDeviceId: string,
  winnerName: string,
  loserName: string
): Promise<{ winner: PlayerStats; loser: PlayerStats }> {
  if (hasDatabase()) {
    const winner = await getPlayerStatsFromDatabase(winnerDeviceId, winnerName);
    const loser = await getPlayerStatsFromDatabase(loserDeviceId, loserName);

    winner.gamesPlayed += 1;
    winner.gamesWon += 1;
    loser.gamesPlayed += 1;
    winner.updatedAt = Date.now();
    loser.updatedAt = Date.now();

    return {
      winner: await savePlayerStats(winner),
      loser: await savePlayerStats(loser)
    };
  }

  const store = loadStore();
  const winner = upsertPlayerInStore(store, winnerDeviceId, winnerName);
  const loser = upsertPlayerInStore(store, loserDeviceId, loserName);

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

export async function recordMatchResult(
  match: SessionMatchResult
): Promise<{ winner: PlayerStats; loser: PlayerStats }> {
  if (hasDatabase()) {
    const winner = await getPlayerStatsFromDatabase(match.winnerDeviceId, match.winnerName);
    const loser = await getPlayerStatsFromDatabase(match.loserDeviceId, match.loserName);

    winner.matchesPlayed += 1;
    winner.matchesWon += 1;
    loser.matchesPlayed += 1;
    winner.updatedAt = Date.now();
    loser.updatedAt = Date.now();

    return {
      winner: await savePlayerStats(winner),
      loser: await savePlayerStats(loser)
    };
  }

  const store = loadStore();
  const winner = upsertPlayerInStore(store, match.winnerDeviceId, match.winnerName);
  const loser = upsertPlayerInStore(store, match.loserDeviceId, match.loserName);

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

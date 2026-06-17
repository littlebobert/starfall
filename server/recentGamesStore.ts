import { RecentGame } from "../shared/game";
import { getPool, hasDatabase } from "./db";

const RECENT_GAMES_LIMIT = 8;

let recentGames: RecentGame[] = [];

export async function initRecentGamesStore(): Promise<void> {
  if (!hasDatabase()) {
    recentGames = [];
    return;
  }

  const pool = getPool();
  const result = await pool.query<RecentGameRow>(
    `SELECT id, room_code, winner_name, loser_name, rounds, completed_at
     FROM recent_games
     ORDER BY completed_at DESC
     LIMIT $1`,
    [RECENT_GAMES_LIMIT]
  );

  recentGames = result.rows.map(rowToRecentGame);
}

export function getRecentGamesSnapshot(): RecentGame[] {
  return recentGames;
}

export async function addRecentGame(game: RecentGame): Promise<RecentGame[]> {
  recentGames = [game, ...recentGames.filter((entry) => entry.id !== game.id)].slice(0, RECENT_GAMES_LIMIT);

  if (hasDatabase()) {
    const pool = getPool();

    await pool.query(
      `INSERT INTO recent_games (id, room_code, winner_name, loser_name, rounds, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         room_code = EXCLUDED.room_code,
         winner_name = EXCLUDED.winner_name,
         loser_name = EXCLUDED.loser_name,
         rounds = EXCLUDED.rounds,
         completed_at = EXCLUDED.completed_at`,
      [game.id, game.roomCode, game.winnerName, game.loserName, game.rounds, game.completedAt]
    );

    await pool.query(
      `DELETE FROM recent_games
       WHERE id NOT IN (
         SELECT id FROM recent_games ORDER BY completed_at DESC LIMIT $1
       )`,
      [RECENT_GAMES_LIMIT]
    );
  }

  return recentGames;
}

interface RecentGameRow {
  id: string;
  room_code: string;
  winner_name: string;
  loser_name: string;
  rounds: number;
  completed_at: number;
}

function rowToRecentGame(row: RecentGameRow): RecentGame {
  return {
    id: row.id,
    roomCode: row.room_code,
    winnerName: row.winner_name,
    loserName: row.loser_name,
    rounds: row.rounds,
    completedAt: Number(row.completed_at)
  };
}

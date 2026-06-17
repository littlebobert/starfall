import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool(): pg.Pool {
  if (!pool) {
    throw new Error("Database not initialized");
  }

  return pool;
}

export async function initDatabase(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.warn("DATABASE_URL not set; using local file/in-memory persistence.");
    return;
  }

  pool = new Pool({
    connectionString,
    ssl: process.env.PGSSLMODE === "disable" ? undefined : { rejectUnauthorized: false }
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_stats (
      device_id TEXT PRIMARY KEY,
      games_played INTEGER NOT NULL DEFAULT 0,
      games_won INTEGER NOT NULL DEFAULT 0,
      matches_played INTEGER NOT NULL DEFAULT 0,
      matches_won INTEGER NOT NULL DEFAULT 0,
      last_name TEXT,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_games (
      id TEXT PRIMARY KEY,
      room_code TEXT NOT NULL,
      winner_name TEXT NOT NULL,
      loser_name TEXT NOT NULL,
      rounds INTEGER NOT NULL,
      completed_at BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS recent_games_completed_at_idx ON recent_games (completed_at DESC);
  `);
}

import pg from "pg";

const { Pool } = pg;

/**
 * Render Postgres:
 * - Set DATABASE_URL in your Render Web Service environment variables
 * - Prefer the Internal Database URL
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render's internal connections typically work without SSL config,
  // but enabling SSL (with rejectUnauthorized false) is safe for managed envs.
  ssl: process.env.PGSSL === "true" || process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

export async function query(text, params = []) {
  const res = await pool.query(text, params);
  return res;
}

export async function initSchema() {
  // Create tables if missing
  await query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    username_lc TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    team_name TEXT NOT NULL,
    rating INT NOT NULL DEFAULT 1000,
    banned BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);

  await query(`
  CREATE TABLE IF NOT EXISTS fights (
    code TEXT PRIMARY KEY,
    team_size INT NOT NULL,
    format TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    match_expires_at TIMESTAMPTZ,
    location TEXT,
    poster_ids INT[] NOT NULL,
    accepter_ids INT[],
    poster_team_name TEXT,
    accepter_team_name TEXT,
    poster_confirm TEXT,
    accepter_confirm TEXT,
    result TEXT,
    rating_delta INT,
    poster_extend BOOLEAN NOT NULL DEFAULT FALSE,
    accepter_extend BOOLEAN NOT NULL DEFAULT FALSE,
    extension_count INT NOT NULL DEFAULT 0
  );`);


  // Ensure newer fight columns exist (safe migrations)
  await query(`ALTER TABLE fights ADD COLUMN IF NOT EXISTS poster_extend BOOLEAN NOT NULL DEFAULT FALSE`);
  await query(`ALTER TABLE fights ADD COLUMN IF NOT EXISTS accepter_extend BOOLEAN NOT NULL DEFAULT FALSE`);
  await query(`ALTER TABLE fights ADD COLUMN IF NOT EXISTS extension_count INT NOT NULL DEFAULT 0`);

  await query(`
  CREATE TABLE IF NOT EXISTS match_history (
    id SERIAL PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    team_size INT NOT NULL,
    format TEXT NOT NULL,
    created_at TIMESTAMPTZ,
    accepted_at TIMESTAMPTZ,
    concluded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    location TEXT,
    poster_ids INT[] NOT NULL,
    accepter_ids INT[] NOT NULL,
    poster_team_name TEXT,
    accepter_team_name TEXT,
    result TEXT NOT NULL,
    rating_delta INT,
    poster_extend BOOLEAN NOT NULL DEFAULT FALSE,
    accepter_extend BOOLEAN NOT NULL DEFAULT FALSE,
    extension_count INT NOT NULL DEFAULT 0
  );`);

  await query(`
  CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_read BOOLEAN NOT NULL DEFAULT FALSE
  );`);

  await query(`
  CREATE TABLE IF NOT EXISTS announcements (
    id SERIAL PRIMARY KEY,
    text TEXT NOT NULL,
    by_username TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);

  await query(`
  CREATE TABLE IF NOT EXISTS match_messages (
    id SERIAL PRIMARY KEY,
    code TEXT NOT NULL,
    side TEXT NOT NULL, -- POSTER / ACCEPTER / SYSTEM / ADMIN
    alias TEXT,
    text TEXT NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);


  await query(`
  CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  await query(`CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);`);


  // Ensure newer match_history columns exist (safe migrations)
  await query(`ALTER TABLE match_history ADD COLUMN IF NOT EXISTS final_status TEXT`);
  await query(`ALTER TABLE match_history ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ`);
  await query(`ALTER TABLE match_history ADD COLUMN IF NOT EXISTS concluded_at TIMESTAMPTZ`);
  await query(`ALTER TABLE match_history ADD COLUMN IF NOT EXISTS poster_team_name TEXT`);
  await query(`ALTER TABLE match_history ADD COLUMN IF NOT EXISTS accepter_team_name TEXT`);
  await query(`ALTER TABLE match_history ADD COLUMN IF NOT EXISTS rating_delta INT`);
  await query(`ALTER TABLE match_history ADD COLUMN IF NOT EXISTS location TEXT`);
  await query(`ALTER TABLE match_history ADD COLUMN IF NOT EXISTS team_size INT`);
  await query(`ALTER TABLE match_history ADD COLUMN IF NOT EXISTS format TEXT`);
  await query(`ALTER TABLE match_history ADD COLUMN IF NOT EXISTS poster_ids INT[]`);
  await query(`ALTER TABLE match_history ADD COLUMN IF NOT EXISTS accepter_ids INT[]`);

  // Useful indexes
  await query(`CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_announcements_created ON announcements(created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_messages_code_at ON match_messages(code, at ASC);`);
}

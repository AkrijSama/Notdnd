PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  setting TEXT NOT NULL,
  status TEXT NOT NULL,
  readiness INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  players_json TEXT NOT NULL,
  source_books_json TEXT NOT NULL,
  active_map_id TEXT,
  active_encounter_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  chapters_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  campaign_id TEXT,
  name TEXT NOT NULL,
  class_name TEXT NOT NULL,
  level INTEGER NOT NULL,
  ac INTEGER NOT NULL,
  hp INTEGER NOT NULL,
  speed INTEGER NOT NULL,
  stats_json TEXT NOT NULL,
  proficiencies_json TEXT NOT NULL,
  spells_json TEXT NOT NULL,
  inventory_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS encounters (
  id TEXT PRIMARY KEY,
  campaign_id TEXT,
  name TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  monsters_json TEXT NOT NULL,
  xp_budget INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS maps (
  id TEXT PRIMARY KEY,
  campaign_id TEXT,
  name TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  fog_enabled INTEGER NOT NULL,
  dynamic_lighting INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL,
  label TEXT NOT NULL,
  color TEXT NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  faction TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS initiative_turns (
  id TEXT PRIMARY KEY,
  campaign_id TEXT,
  name TEXT NOT NULL,
  value INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS chat_log (
  id TEXT PRIMARY KEY,
  campaign_id TEXT,
  speaker TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ai_jobs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT,
  type TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  provider_name TEXT,
  model_value TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS journals (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  visibility TEXT NOT NULL,
  author_user_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS roll_history (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  expression TEXT NOT NULL,
  total INTEGER NOT NULL,
  detail_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS revealed_cells (
  map_id TEXT NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  revealed INTEGER NOT NULL,
  PRIMARY KEY (map_id, x, y),
  FOREIGN KEY (map_id) REFERENCES maps(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gm_settings (
  campaign_id TEXT PRIMARY KEY,
  gm_name TEXT NOT NULL,
  gm_style TEXT NOT NULL,
  safety_profile TEXT NOT NULL,
  primary_rulebook TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/socialmind.db');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function addColumnIfMissing(tableName, columnName, columnSql) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const hasColumn = columns.some((column) => column.name === columnName);
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql}`);
    console.log(`[DB] Added missing column ${tableName}.${columnName}`);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL CHECK(platform IN ('instagram', 'tiktok')),
    account_id TEXT NOT NULL,
    username TEXT NOT NULL,
    access_token TEXT NOT NULL,
    token_expiry INTEGER,
    page_id TEXT,
    auth_type TEXT DEFAULT 'facebook_login',
    is_active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(platform, account_id)
  );

  CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    name TEXT NOT NULL,
    trigger_type TEXT NOT NULL CHECK(trigger_type IN ('any', 'keyword')),
    keywords TEXT DEFAULT '[]',
    action_type TEXT NOT NULL CHECK(action_type IN ('reply_comment', 'reply_dm', 'both')),
    comment_template TEXT,
    dm_template TEXT,
    target_media_id TEXT,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    rule_id TEXT,
    event_type TEXT NOT NULL,
    platform TEXT NOT NULL,
    commenter_id TEXT,
    commenter_username TEXT,
    comment_text TEXT,
    media_id TEXT,
    action_taken TEXT,
    response_text TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'failed', 'skipped')),
    error_message TEXT,
    scheduled_at INTEGER,
    executed_at INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS spam_tracker (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    target_user_id TEXT NOT NULL,
    last_action_at INTEGER NOT NULL,
    action_count_hour INTEGER DEFAULT 1,
    UNIQUE(account_id, target_user_id)
  );

  CREATE TABLE IF NOT EXISTS hourly_stats (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    hour_bucket INTEGER NOT NULL,
    reply_count INTEGER DEFAULT 0,
    UNIQUE(account_id, hour_bucket)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER DEFAULT (unixepoch())
  );
`);

addColumnIfMissing('settings', 'updated_at', 'updated_at INTEGER');
addColumnIfMissing('accounts', 'auth_type', "auth_type TEXT DEFAULT 'facebook_login'");

db.prepare(`
  UPDATE accounts
  SET auth_type = 'facebook_login'
  WHERE platform = 'instagram' AND (auth_type IS NULL OR auth_type = '')
`).run();

// Seed defaults — INSERT OR IGNORE only inserts if key doesn't exist
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
insertSetting.run('anthropic_api_key', '');
insertSetting.run('ai_prompt_template', 'You are a friendly social media assistant. Reply to this comment in a helpful, engaging way. Keep it under 150 characters. Comment: {{comment}}');
insertSetting.run('min_delay_seconds', '45');
insertSetting.run('max_delay_seconds', '120');
insertSetting.run('max_replies_per_hour', '30');
insertSetting.run('user_cooldown_minutes', '60');
insertSetting.run('meta_app_id', '');
insertSetting.run('meta_app_secret', '');
insertSetting.run('meta_login_config_id', '');
insertSetting.run('tiktok_client_key', '');
insertSetting.run('tiktok_client_secret', '');

// Auto-sync: if ENV vars are set, overwrite DB settings (handles Railway redeploys)
const ENV_TO_SETTINGS = {
  META_APP_ID:            'meta_app_id',
  META_APP_SECRET:        'meta_app_secret',
  META_LOGIN_CONFIG_ID:   'meta_login_config_id',
  TIKTOK_CLIENT_KEY:      'tiktok_client_key',
  TIKTOK_CLIENT_SECRET:   'tiktok_client_secret',
  ANTHROPIC_API_KEY:      'anthropic_api_key',
};

const upsertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()');
for (const [envKey, dbKey] of Object.entries(ENV_TO_SETTINGS)) {
  if (process.env[envKey]) {
    upsertSetting.run(dbKey, process.env[envKey]);
    console.log(`[DB] Setting "${dbKey}" synced from ENV var ${envKey}`);
  }
}

addColumnIfMissing('rules', 'target_media_id', 'target_media_id TEXT');

module.exports = db;

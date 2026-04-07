const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/socialmind.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);

// Enable WAL mode and foreign keys
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL CHECK(platform IN ('instagram', 'tiktok')),
    account_id TEXT NOT NULL,
    username TEXT NOT NULL,
    access_token TEXT NOT NULL,
    token_expiry INTEGER,
    page_id TEXT,
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

// Add a transaction helper to match better-sqlite3 API
db.transaction = function(fn) {
  return function(...args) {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
};

// Insert default settings if not exist
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
insertSetting.run('anthropic_api_key', '');
insertSetting.run('ai_prompt_template', 'You are a friendly social media assistant. Reply to this comment in a helpful, engaging way. Keep it under 150 characters. Comment: {{comment}}');
insertSetting.run('min_delay_seconds', '45');
insertSetting.run('max_delay_seconds', '120');
insertSetting.run('max_replies_per_hour', '30');
insertSetting.run('user_cooldown_minutes', '60');

module.exports = db;

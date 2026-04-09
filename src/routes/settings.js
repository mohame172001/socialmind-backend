const express = require('express');
const db = require('../db');

const router = express.Router();

const ALLOWED_KEYS = [
  'anthropic_api_key',
  'ai_prompt_template',
  'min_delay_seconds',
  'max_delay_seconds',
  'max_replies_per_hour',
  'user_cooldown_minutes',
  'meta_app_id',
  'meta_app_secret',
  'tiktok_client_key',
  'tiktok_client_secret'
];

// ENV var mapping (same as oauth.js)
const ENV_MAP = {
  meta_app_id:          'META_APP_ID',
  meta_app_secret:      'META_APP_SECRET',
  tiktok_client_key:    'TIKTOK_CLIENT_KEY',
  tiktok_client_secret: 'TIKTOK_CLIENT_SECRET',
  anthropic_api_key:    'ANTHROPIC_API_KEY',
};

// Effective value: ENV overrides DB
function effectiveValue(key, dbValue) {
  const envKey = ENV_MAP[key];
  if (envKey && process.env[envKey]) return process.env[envKey];
  return dbValue;
}

// GET all settings (mask secrets, show effective values)
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) {
    const val = effectiveValue(row.key, row.value);
    const MASKED = ['anthropic_api_key', 'meta_app_secret', 'tiktok_client_secret'];
    if (MASKED.includes(row.key) && val) {
      settings[row.key] = val.substring(0, 4) + '...' + val.slice(-4);
    } else {
      settings[row.key] = val;
    }
  }
  res.json(settings);
});

// Secret keys — NEVER overwrite with empty string
const SECRET_KEYS = ['anthropic_api_key', 'meta_app_secret', 'tiktok_client_secret'];

// PUT update settings
router.put('/', (req, res) => {
  const updates = req.body;
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())');

  let updatedKeys = [];
  let skippedKeys = [];

  const updateMany = db.transaction((updates) => {
    for (const [key, value] of Object.entries(updates)) {
      if (!ALLOWED_KEYS.includes(key)) continue;

      const strVal = String(value).trim();

      // Skip empty values for secret keys — don't overwrite saved secrets with ""
      if (SECRET_KEYS.includes(key) && !strVal) {
        skippedKeys.push(key);
        continue;
      }

      stmt.run(key, strVal);
      updatedKeys.push(key);
    }
  });

  updateMany(updates);
  console.log('[Settings] Updated:', updatedKeys.join(', ') || 'none');
  if (skippedKeys.length) console.log('[Settings] Skipped (empty secret):', skippedKeys.join(', '));
  res.json({ success: true, updated: updatedKeys, skipped_empty_secrets: skippedKeys });
});

// GET config status — for frontend to know what's ready
router.get('/status', (req, res) => {
  const get = (k) => {
    const envKey = ENV_MAP[k];
    if (envKey && process.env[envKey]) return { set: true, source: 'env' };
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    if (row?.value) return { set: true, source: 'db' };
    return { set: false, source: 'none' };
  };
  res.json({
    meta_app_id: get('meta_app_id'),
    meta_app_secret: get('meta_app_secret'),
    anthropic_api_key: get('anthropic_api_key'),
    tiktok_client_key: get('tiktok_client_key'),
    oauth_ready: get('meta_app_id').set && get('meta_app_secret').set,
  });
});

// POST /api/settings/chat - voice agent chat (Arabic)
router.post('/chat', async (req, res) => {
  const { command, history = [] } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });

  const apiKey = db.prepare('SELECT value FROM settings WHERE key=?').get('anthropic_api_key')?.value;
  if (!apiKey) return res.json({ response: 'لم يتم ضبط مفتاح الذكاء الاصطناعي. روح Settings وأضفه.' });

  const accounts = db.prepare('SELECT platform, username, is_active FROM accounts').all();
  const stats    = db.prepare(`SELECT
    COUNT(CASE WHEN status='sent'    AND created_at>(unixepoch()-86400) THEN 1 END) sent_today,
    COUNT(CASE WHEN status='failed'  AND created_at>(unixepoch()-86400) THEN 1 END) failed_today,
    COUNT(CASE WHEN status='pending'                                     THEN 1 END) pending
    FROM activity_log`).get();

  const accText = accounts.length
    ? accounts.map(a => `@${a.username} (${a.platform === 'instagram' ? 'انستجرام' : 'تيك توك'})`).join(', ')
    : 'لا يوجد حسابات';

  const system = `أنت "ميندي"، مساعد سوشيال ميديا ذكي وودود. تتكلم عربي مصري طبيعي.
حالة التطبيق: ${accText} | أُرسل اليوم: ${stats?.sent_today||0} | فشل: ${stats?.failed_today||0} | انتظار: ${stats?.pending||0}
رد بشكل طبيعي ومتفاعل على أي سؤال - مش لازم يكون عن التطبيق فقط.`;

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const msgs   = [...history.slice(-10), { role: 'user', content: command }];
    const result = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 400, system, messages: msgs
    });
    res.json({ response: result.content[0].text.trim() });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ response: 'حصل خطأ، جرب تاني.' });
  }
});

// GET test AI connection
router.get('/test-ai', async (req, res) => {
  try {
    const { generateReply } = require('../services/aiService');
    const reply = await generateReply('Hello! Love your content!', 'testuser', { platform: 'instagram' });
    res.json({ success: true, sample_reply: reply });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;

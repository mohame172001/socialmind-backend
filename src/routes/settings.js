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

// GET all settings (mask API key)
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) {
    const MASKED = ['anthropic_api_key', 'meta_app_secret', 'tiktok_client_secret'];
    if (MASKED.includes(row.key) && row.value) {
      settings[row.key] = row.value.substring(0, 4) + '...' + row.value.slice(-4);
    } else {
      settings[row.key] = row.value;
    }
  }
  res.json(settings);
});

// PUT update settings
router.put('/', (req, res) => {
  const updates = req.body;
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())');

  const updateMany = db.transaction((updates) => {
    for (const [key, value] of Object.entries(updates)) {
      if (ALLOWED_KEYS.includes(key)) {
        stmt.run(key, String(value));
      }
    }
  });

  updateMany(updates);
  res.json({ success: true });
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

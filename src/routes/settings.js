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

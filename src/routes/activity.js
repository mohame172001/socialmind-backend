const express = require('express');
const db = require('../db');
const queue = require('../queue/spamQueue');

const router = express.Router();

// GET activity log with pagination
router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const account_id = req.query.account_id;
  const status = req.query.status;

  let query = `
    SELECT al.*, a.username, a.platform
    FROM activity_log al
    LEFT JOIN accounts a ON al.account_id = a.id
    WHERE 1=1
  `;
  const params = [];

  if (account_id) { query += ' AND al.account_id = ?'; params.push(account_id); }
  if (status) { query += ' AND al.status = ?'; params.push(status); }

  query += ' ORDER BY al.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const items = db.prepare(query).all(...params);
  const total = db.prepare(`SELECT COUNT(*) as count FROM activity_log WHERE 1=1${account_id ? ' AND account_id = ?' : ''}${status ? ' AND status = ?' : ''}`).get(...params.slice(0, -2));

  res.json({ items, total: total.count, limit, offset });
});

// GET dashboard stats
router.get('/stats', (req, res) => {
  const bucket = Math.floor(Date.now() / 3600000);
  const today = Math.floor(new Date().setHours(0,0,0,0) / 1000);

  const totalAccounts = db.prepare('SELECT COUNT(*) as count FROM accounts WHERE is_active = 1').get();
  const totalRules = db.prepare('SELECT COUNT(*) as count FROM rules WHERE is_active = 1').get();
  const sentToday = db.prepare("SELECT COUNT(*) as count FROM activity_log WHERE status = 'sent' AND created_at >= ?").get(today);
  const pendingNow = db.prepare("SELECT COUNT(*) as count FROM activity_log WHERE status = 'pending'").get();
  const failedToday = db.prepare("SELECT COUNT(*) as count FROM activity_log WHERE status = 'failed' AND created_at >= ?").get(today);
  const totalSent = db.prepare("SELECT COUNT(*) as count FROM activity_log WHERE status = 'sent'").get();

  const queueStats = queue.getStats();

  res.json({
    active_accounts: totalAccounts.count,
    active_rules: totalRules.count,
    sent_today: sentToday.count,
    pending_now: pendingNow.count,
    failed_today: failedToday.count,
    total_sent: totalSent.count,
    queue_length: queueStats.queueLength
  });
});

// GET queue status
router.get('/queue', (req, res) => {
  res.json(queue.getStats());
});

// POST /api/activity/chat - voice agent (Arabic)
router.post('/chat', async (req, res) => {
  const { command, history = [] } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });

  const apiKey = db.prepare('SELECT value FROM settings WHERE key=?').get('anthropic_api_key')?.value;
  if (!apiKey) return res.json({ response: 'مفيش API key. روح Settings وأضفه.' });

  const accounts = db.prepare('SELECT platform, username FROM accounts WHERE is_active=1').all();
  const stats    = db.prepare(`SELECT
    COUNT(CASE WHEN status='sent'   AND created_at>(unixepoch()-86400) THEN 1 END) s,
    COUNT(CASE WHEN status='failed' AND created_at>(unixepoch()-86400) THEN 1 END) f,
    COUNT(CASE WHEN status='pending' THEN 1 END) p FROM activity_log`).get();

  const accText = accounts.length
    ? accounts.map(a=>`@${a.username}(${a.platform})`).join(', ')
    : 'لا يوجد حسابات بعد';

  const system = `أنت "ميندي"، مساعد ذكي ومتفاعل لتطبيق SocialMind.
تتكلم عربي مصري بشكل طبيعي وودود مع سيدي.
الحسابات: ${accText} | أُرسل اليوم: ${stats?.s||0} | فشل: ${stats?.f||0} | انتظار: ${stats?.p||0}
رد بشكل طبيعي على أي سؤال - سواء عن التطبيق أو أي حاجة تانية.`;

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const msgs = [...history.slice(-10), { role:'user', content:command }];
    const out  = await new Anthropic({ apiKey }).messages.create({
      model:'claude-haiku-4-5-20251001', max_tokens:400, system, messages:msgs
    });
    res.json({ response: out.content[0].text.trim() });
  } catch(e) {
    console.error('chat:', e.message);
    res.status(500).json({ response: 'حصل خطأ، جرب تاني.' });
  }
});

module.exports = router;

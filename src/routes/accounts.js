const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

// GET all accounts
router.get('/', (req, res) => {
  const accounts = db.prepare(`
    SELECT id, platform, account_id, username, page_id, is_active, created_at,
           token_expiry, CASE WHEN access_token != '' THEN 1 ELSE 0 END as has_token
    FROM accounts ORDER BY created_at DESC
  `).all();
  res.json(accounts);
});

// POST create account
router.post('/', (req, res) => {
  const { platform, account_id, username, access_token, page_id, token_expiry } = req.body;

  if (!platform || !account_id || !username || !access_token) {
    return res.status(400).json({ error: 'platform, account_id, username, access_token are required' });
  }

  if (!['instagram', 'tiktok'].includes(platform)) {
    return res.status(400).json({ error: 'platform must be instagram or tiktok' });
  }

  try {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO accounts (id, platform, account_id, username, access_token, page_id, token_expiry)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, platform, account_id, username, access_token, page_id || null, token_expiry || null);

    res.status(201).json({ id, platform, account_id, username, is_active: 1 });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      res.status(409).json({ error: 'Account already exists' });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// PUT update account
router.put('/:id', (req, res) => {
  const { username, access_token, page_id, token_expiry, is_active } = req.body;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  db.prepare(`
    UPDATE accounts SET
      username = COALESCE(?, username),
      access_token = COALESCE(?, access_token),
      page_id = COALESCE(?, page_id),
      token_expiry = COALESCE(?, token_expiry),
      is_active = COALESCE(?, is_active),
      updated_at = unixepoch()
    WHERE id = ?
  `).run(username, access_token, page_id, token_expiry, is_active, req.params.id);

  res.json({ success: true });
});

// DELETE account
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Account not found' });
  res.json({ success: true });
});

// GET account stats
router.get('/:id/stats', (req, res) => {
  const bucket = Math.floor(Date.now() / 3600000);
  const hourly = db.prepare('SELECT reply_count FROM hourly_stats WHERE account_id = ? AND hour_bucket = ?').get(req.params.id, bucket);
  const total = db.prepare("SELECT COUNT(*) as count FROM activity_log WHERE account_id = ? AND status = 'sent'").get(req.params.id);
  const pending = db.prepare("SELECT COUNT(*) as count FROM activity_log WHERE account_id = ? AND status = 'pending'").get(req.params.id);

  res.json({
    replies_this_hour: hourly?.reply_count || 0,
    total_sent: total?.count || 0,
    pending: pending?.count || 0
  });
});

module.exports = router;

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

// GET all rules (optionally filter by account)
router.get('/', (req, res) => {
  const { account_id } = req.query;
  let rules;
  if (account_id) {
    rules = db.prepare(`
      SELECT r.*, a.username, a.platform
      FROM rules r JOIN accounts a ON r.account_id = a.id
      WHERE r.account_id = ? ORDER BY r.created_at DESC
    `).all(account_id);
  } else {
    rules = db.prepare(`
      SELECT r.*, a.username, a.platform
      FROM rules r JOIN accounts a ON r.account_id = a.id
      ORDER BY r.created_at DESC
    `).all();
  }
  rules = rules.map(r => ({ ...r, keywords: JSON.parse(r.keywords || '[]') }));
  res.json(rules);
});

// POST create rule
router.post('/', (req, res) => {
  const { account_id, name, trigger_type, keywords, action_type, comment_template, dm_template, target_media_id } = req.body;

  if (!account_id || !name || !trigger_type || !action_type) {
    return res.status(400).json({ error: 'account_id, name, trigger_type, action_type are required' });
  }

  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(account_id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO rules (id, account_id, name, trigger_type, keywords, action_type, comment_template, dm_template, target_media_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, account_id, name, trigger_type, JSON.stringify(keywords || []), action_type, comment_template || null, dm_template || null, target_media_id || null);

  res.status(201).json({ id, account_id, name, trigger_type, keywords: keywords || [], action_type, target_media_id: target_media_id || null, is_active: 1 });
});

// PUT update rule
router.put('/:id', (req, res) => {
  const { name, trigger_type, keywords, action_type, comment_template, dm_template, target_media_id, is_active } = req.body;
  const rule = db.prepare('SELECT * FROM rules WHERE id = ?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });

  db.prepare(`
    UPDATE rules SET
      name = COALESCE(?, name),
      trigger_type = COALESCE(?, trigger_type),
      keywords = COALESCE(?, keywords),
      action_type = COALESCE(?, action_type),
      comment_template = COALESCE(?, comment_template),
      dm_template = COALESCE(?, dm_template),
      target_media_id = ?,
      is_active = COALESCE(?, is_active),
      updated_at = unixepoch()
    WHERE id = ?
  `).run(
    name, trigger_type,
    keywords ? JSON.stringify(keywords) : null,
    action_type, comment_template, dm_template,
    target_media_id !== undefined ? (target_media_id || null) : rule.target_media_id,
    is_active,
    req.params.id
  );

  res.json({ success: true });
});

// DELETE rule
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM rules WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Rule not found' });
  res.json({ success: true });
});

module.exports = router;

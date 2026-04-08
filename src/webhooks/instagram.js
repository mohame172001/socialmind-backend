const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const queue = require('../queue/spamQueue');
const aiService = require('../services/aiService');
const instagramService = require('../services/instagramService');

const router = express.Router();

const VERIFY_TOKEN = process.env.INSTAGRAM_VERIFY_TOKEN || 'socialmind_verify_2024';

// Webhook verification (GET)
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[Instagram] Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ error: 'Verification failed' });
  }
});

// Webhook events (POST)
router.post('/', express.json(), (req, res) => {
  // Respond immediately to Meta
  res.status(200).send('EVENT_RECEIVED');

  const body = req.body;
  if (!body || body.object !== 'instagram') return;

  const entries = body.entry || [];
  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const change of changes) {
      if (change.field === 'comments') {
        handleComment(change.value, entry.id).catch(console.error);
      } else if (change.field === 'messages') {
        // handle inbound messages if needed
      }
    }
  }
});

async function handleComment(data, pageId) {
  const commentId = data.id;
  const commentText = data.text || '';
  const commenterId = data.from?.id;
  const commenterName = data.from?.username || data.from?.name;
  const mediaId = data.media?.id;

  console.log(`[Instagram] New comment from ${commenterName}: "${commentText}"`);

  // Find matching account
  const account = db.prepare(
    'SELECT * FROM accounts WHERE platform = ? AND (page_id = ? OR account_id = ?) AND is_active = 1'
  ).get('instagram', pageId, pageId);

  if (!account) {
    console.log('[Instagram] No matching account found for page:', pageId);
    return;
  }

  // Find matching rules
  const rules = db.prepare(
    'SELECT * FROM rules WHERE account_id = ? AND is_active = 1'
  ).all(account.id);

  for (const rule of rules) {
    // Skip if rule targets a specific post and this comment is on a different post
    if (rule.target_media_id && rule.target_media_id !== mediaId) continue;

    const matches = checkRuleMatch(rule, commentText);
    if (!matches) continue;

    // Determine what to send
    const shouldReplyComment = ['reply_comment', 'both'].includes(rule.action_type);
    const shouldSendDM = ['reply_dm', 'both'].includes(rule.action_type);

    if (shouldReplyComment) {
      await scheduleAction({
        account,
        rule,
        commentId,
        commentText,
        commenterId,
        commenterName,
        mediaId,
        actionType: 'comment_reply',
        template: rule.comment_template,
        platform: 'instagram'
      });
    }

    if (shouldSendDM) {
      await scheduleAction({
        account,
        rule,
        commentId,
        commentText,
        commenterId,
        commenterName,
        mediaId,
        actionType: 'dm',
        template: rule.dm_template,
        platform: 'instagram'
      });
    }
  }
}

function checkRuleMatch(rule, commentText) {
  if (rule.trigger_type === 'any') return true;
  if (rule.trigger_type === 'keyword') {
    const keywords = JSON.parse(rule.keywords || '[]');
    const lowerComment = commentText.toLowerCase();
    return keywords.some(kw => lowerComment.includes(kw.toLowerCase()));
  }
  return false;
}

async function scheduleAction({ account, rule, commentId, commentText, commenterId, commenterName, mediaId, actionType, template, platform }) {
  const logId = uuidv4();

  db.prepare(`
    INSERT INTO activity_log (id, account_id, rule_id, event_type, platform, commenter_id, commenter_username, comment_text, media_id, action_taken, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', unixepoch())
  `).run(logId, account.id, rule.id, 'comment_received', platform, commenterId, commenterName, commentText, mediaId, actionType);

  queue.enqueue({
    logId,
    accountId: account.id,
    targetUserId: commenterId,
    execute: async () => {
      let responseText;

      if (template && template.trim()) {
        responseText = template
          .replace('{{username}}', commenterName || 'there')
          .replace('{{comment}}', commentText);
      } else {
        responseText = await aiService.generateReply(commentText, commenterName, { platform });
      }

      if (actionType === 'comment_reply') {
        await instagramService.replyToComment(commentId, responseText, account.access_token);
      } else if (actionType === 'dm') {
        await instagramService.sendDM(commenterId, responseText, account.page_id || account.account_id, account.access_token);
      }

      db.prepare('UPDATE activity_log SET response_text = ? WHERE id = ?').run(responseText, logId);
    }
  });
}

module.exports = router;

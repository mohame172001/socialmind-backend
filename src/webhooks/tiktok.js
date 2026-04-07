const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const queue = require('../queue/spamQueue');
const aiService = require('../services/aiService');
const tiktokService = require('../services/tiktokService');

const router = express.Router();

const VERIFY_TOKEN = process.env.TIKTOK_VERIFY_TOKEN || 'socialmind_tiktok_2024';

// TikTok webhook verification
router.get('/', (req, res) => {
  const token = req.query.verify_token;
  if (token === VERIFY_TOKEN) {
    res.status(200).send(req.query.challenge || 'ok');
  } else {
    res.status(403).json({ error: 'Verification failed' });
  }
});

// TikTok webhook events
router.post('/', express.json(), (req, res) => {
  res.status(200).json({ message: 'ok' });

  const body = req.body;
  if (!body) return;

  // Handle comment events
  if (body.event === 'comment.create' || body.type === 'comment') {
    handleTikTokComment(body).catch(console.error);
  }
});

async function handleTikTokComment(data) {
  const commentId = data.comment_id || data.id;
  const commentText = data.comment?.text || data.text || '';
  const commenterId = data.user?.open_id || data.from?.open_id;
  const commenterName = data.user?.display_name || data.from?.display_name || 'user';
  const videoId = data.video?.id || data.video_id;
  const accountId = data.business_id || data.account_id;

  console.log(`[TikTok] New comment from ${commenterName}: "${commentText}"`);

  const account = db.prepare(
    'SELECT * FROM accounts WHERE platform = ? AND account_id = ? AND is_active = 1'
  ).get('tiktok', accountId);

  if (!account) {
    console.log('[TikTok] No matching account found:', accountId);
    return;
  }

  const rules = db.prepare('SELECT * FROM rules WHERE account_id = ? AND is_active = 1').all(account.id);

  for (const rule of rules) {
    const matches = checkRuleMatch(rule, commentText);
    if (!matches) continue;

    const shouldReplyComment = ['reply_comment', 'both'].includes(rule.action_type);
    const shouldSendDM = ['reply_dm', 'both'].includes(rule.action_type);

    if (shouldReplyComment) {
      await scheduleAction({ account, rule, commentId, videoId, commentText, commenterId, commenterName, actionType: 'comment_reply', template: rule.comment_template });
    }
    if (shouldSendDM) {
      await scheduleAction({ account, rule, commentId, videoId, commentText, commenterId, commenterName, actionType: 'dm', template: rule.dm_template });
    }
  }
}

function checkRuleMatch(rule, commentText) {
  if (rule.trigger_type === 'any') return true;
  if (rule.trigger_type === 'keyword') {
    const keywords = JSON.parse(rule.keywords || '[]');
    const lower = commentText.toLowerCase();
    return keywords.some(kw => lower.includes(kw.toLowerCase()));
  }
  return false;
}

async function scheduleAction({ account, rule, commentId, videoId, commentText, commenterId, commenterName, actionType, template }) {
  const logId = uuidv4();

  db.prepare(`
    INSERT INTO activity_log (id, account_id, rule_id, event_type, platform, commenter_id, commenter_username, comment_text, media_id, action_taken, status, created_at)
    VALUES (?, ?, ?, ?, 'tiktok', ?, ?, ?, ?, ?, 'pending', unixepoch())
  `).run(logId, account.id, rule.id, 'comment_received', commenterId, commenterName, commentText, videoId, actionType);

  queue.enqueue({
    logId,
    accountId: account.id,
    targetUserId: commenterId,
    execute: async () => {
      let responseText;
      if (template && template.trim()) {
        responseText = template
          .replace('{{username}}', commenterName)
          .replace('{{comment}}', commentText);
      } else {
        responseText = await aiService.generateReply(commentText, commenterName, { platform: 'tiktok' });
      }

      if (actionType === 'comment_reply') {
        await tiktokService.replyToComment(videoId, commentId, responseText, account.access_token);
      } else if (actionType === 'dm') {
        await tiktokService.sendDM(commenterId, responseText, account.access_token);
      }

      db.prepare('UPDATE activity_log SET response_text = ? WHERE id = ?').run(responseText, logId);
    }
  });
}

module.exports = router;

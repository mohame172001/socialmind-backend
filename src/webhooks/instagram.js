const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const queue = require('../queue/spamQueue');
const aiService = require('../services/aiService');
const instagramService = require('../services/instagramService');

const router = express.Router();

const VERIFY_TOKEN = process.env.INSTAGRAM_VERIFY_TOKEN || 'socialmind_verify_2024';

// ── In-memory webhook event log (last 50 events) ────────────────────────────
const webhookHistory = [];
const MAX_HISTORY = 50;

function logWebhookEvent(type, data) {
  const event = {
    timestamp: new Date().toISOString(),
    unix: Date.now(),
    type,
    ...data
  };
  webhookHistory.unshift(event);
  if (webhookHistory.length > MAX_HISTORY) webhookHistory.pop();
  return event;
}

// ── GET /webhooks/instagram/history — debug endpoint ─────────────────────────
router.get('/history', (req, res) => {
  res.json({
    total_events: webhookHistory.length,
    events: webhookHistory
  });
});

// ── Webhook verification (GET) ───────────────────────────────────────────────
// NOTE: Express qs parser may parse "hub.mode" as either:
//   req.query['hub.mode']   (allowDots=false, default)
//   req.query.hub.mode      (allowDots=true, some environments)
// We handle BOTH to be safe across all deployments.
router.get('/', (req, res) => {
  const q = req.query;
  const mode      = q['hub.mode']         || q.hub?.mode;
  const token     = q['hub.verify_token'] || q.hub?.verify_token;
  const challenge = q['hub.challenge']    || q.hub?.challenge;

  console.log('═══════════════════════════════════════');
  console.log('[Webhook][GET] Verification request');
  console.log('[Webhook][GET] Full query:', JSON.stringify(q));
  console.log('[Webhook][GET] mode:', mode);
  console.log('[Webhook][GET] token:', token);
  console.log('[Webhook][GET] challenge:', challenge);
  console.log('[Webhook][GET] expected token:', VERIFY_TOKEN);
  console.log('[Webhook][GET] match:', token === VERIFY_TOKEN);
  console.log('[Webhook][GET] VERIFY_TOKEN source:', process.env.INSTAGRAM_VERIFY_TOKEN ? 'ENV' : 'fallback');
  console.log('═══════════════════════════════════════');

  logWebhookEvent('verification', { mode, token_match: token === VERIFY_TOKEN, challenge, raw_query: q });

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[Webhook][GET] ✅ Verified — sending challenge back');
    res.status(200).send(String(challenge));
  } else {
    console.log('[Webhook][GET] ❌ Verification FAILED');
    console.log('[Webhook][GET] Reason:', !mode ? 'mode missing' : mode !== 'subscribe' ? `mode="${mode}" not "subscribe"` : `token mismatch: got "${token}" expected "${VERIFY_TOKEN}"`);
    res.status(403).json({ error: 'Verification failed' });
  }
});

// ── Webhook events (POST) ────────────────────────────────────────────────────
router.post('/', express.json(), (req, res) => {
  const receiveTime = new Date().toISOString();

  // Respond immediately to Meta (they want < 5s)
  res.status(200).send('EVENT_RECEIVED');

  // ── Full diagnostic logging ──
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║          WEBHOOK POST RECEIVED                           ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('[Webhook][POST] Time:', receiveTime);
  console.log('[Webhook][POST] IP:', req.ip || req.connection?.remoteAddress);
  console.log('[Webhook][POST] Content-Type:', req.headers['content-type']);
  console.log('[Webhook][POST] User-Agent:', req.headers['user-agent']);
  console.log('[Webhook][POST] X-Hub-Signature:', req.headers['x-hub-signature-256'] || 'none');
  console.log('[Webhook][POST] Raw body type:', typeof req.body);
  console.log('[Webhook][POST] Raw body:', JSON.stringify(req.body, null, 2));

  const body = req.body;

  if (!body) {
    console.log('[Webhook][POST] ❌ EMPTY BODY — no data received');
    logWebhookEvent('error', { reason: 'empty_body' });
    return;
  }

  if (body.object !== 'instagram') {
    console.log('[Webhook][POST] ❌ WRONG OBJECT:', body.object, '(expected "instagram")');
    logWebhookEvent('error', { reason: 'wrong_object', object: body.object, body });
    return;
  }

  console.log('[Webhook][POST] ✅ Object: instagram');

  const entries = body.entry || [];
  console.log('[Webhook][POST] Entries count:', entries.length);

  if (entries.length === 0) {
    console.log('[Webhook][POST] ❌ NO ENTRIES in body');
    logWebhookEvent('error', { reason: 'no_entries', body });
    return;
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    console.log(`[Webhook][POST] Entry[${i}] id:`, entry.id);
    console.log(`[Webhook][POST] Entry[${i}] time:`, entry.time);

    const changes = entry.changes || [];
    console.log(`[Webhook][POST] Entry[${i}] changes count:`, changes.length);

    if (changes.length === 0) {
      console.log(`[Webhook][POST] ❌ Entry[${i}] has NO CHANGES`);
      logWebhookEvent('entry_no_changes', { entry_id: entry.id });
    }

    for (let j = 0; j < changes.length; j++) {
      const change = changes[j];
      console.log(`[Webhook][POST] Entry[${i}].Change[${j}] field:`, change.field);
      console.log(`[Webhook][POST] Entry[${i}].Change[${j}] value:`, JSON.stringify(change.value));

      logWebhookEvent('change_received', {
        entry_id: entry.id,
        field: change.field,
        value: change.value
      });

      if (change.field === 'comments') {
        console.log(`[Webhook][POST] ✅ COMMENT detected — calling handleComment()`);
        handleComment(change.value, entry.id).catch(err => {
          console.error(`[Webhook][POST] ❌ handleComment THREW:`, err.message, err.stack);
          logWebhookEvent('handle_error', { error: err.message, entry_id: entry.id });
        });
      } else if (change.field === 'messages') {
        console.log(`[Webhook][POST] 📩 MESSAGE detected (not handled yet)`);
        logWebhookEvent('message_ignored', { entry_id: entry.id, value: change.value });
      } else {
        console.log(`[Webhook][POST] ⚠️ UNKNOWN field: "${change.field}" — ignored`);
        logWebhookEvent('unknown_field', { field: change.field, entry_id: entry.id });
      }
    }
  }
  console.log('───────────────────────────────────────────────────────────');
});

// ── Comment handler ──────────────────────────────────────────────────────────
async function handleComment(data, pageId) {
  const commentId = data.id;
  const commentText = data.text || '';
  const commenterId = data.from?.id;
  const commenterName = data.from?.username || data.from?.name;
  const mediaId = data.media?.id;

  console.log(`[handleComment] ── START ──`);
  console.log(`[handleComment] Comment ID: ${commentId}`);
  console.log(`[handleComment] Text: "${commentText}"`);
  console.log(`[handleComment] From: ${commenterName} (ID: ${commenterId})`);
  console.log(`[handleComment] Media ID: ${mediaId}`);
  console.log(`[handleComment] Page/Entry ID: ${pageId}`);

  // Find matching account
  const account = db.prepare(
    'SELECT * FROM accounts WHERE platform = ? AND (page_id = ? OR account_id = ?) AND is_active = 1'
  ).get('instagram', pageId, pageId);

  if (!account) {
    console.log(`[handleComment] ❌ NO MATCHING ACCOUNT for page/id: ${pageId}`);
    // Show all accounts for debugging
    const allAccounts = db.prepare('SELECT id, platform, account_id, page_id, username, is_active FROM accounts').all();
    console.log(`[handleComment] All accounts in DB:`, JSON.stringify(allAccounts));
    logWebhookEvent('no_account_match', { pageId, allAccounts });
    return;
  }

  console.log(`[handleComment] ✅ Matched account: @${account.username} (account_id: ${account.account_id}, page_id: ${account.page_id})`);

  // Find matching rules
  const rules = db.prepare(
    'SELECT * FROM rules WHERE account_id = ? AND is_active = 1'
  ).all(account.id);

  console.log(`[handleComment] Active rules for this account: ${rules.length}`);

  if (rules.length === 0) {
    console.log(`[handleComment] ❌ NO ACTIVE RULES for account ${account.id}`);
    logWebhookEvent('no_rules', { account_id: account.id, username: account.username });
    return;
  }

  let matchedAny = false;

  for (const rule of rules) {
    console.log(`[handleComment] Checking rule: "${rule.name}" (trigger: ${rule.trigger_type}, target_media: ${rule.target_media_id || 'ALL'})`);

    // Skip if rule targets a specific post and this comment is on a different post
    if (rule.target_media_id && rule.target_media_id !== mediaId) {
      console.log(`[handleComment]   ⏭️ Skipped — media mismatch (rule wants ${rule.target_media_id}, got ${mediaId})`);
      continue;
    }

    const matches = checkRuleMatch(rule, commentText);
    if (!matches) {
      console.log(`[handleComment]   ⏭️ Skipped — trigger not matched`);
      continue;
    }

    console.log(`[handleComment]   ✅ RULE MATCHED: "${rule.name}"`);
    matchedAny = true;

    // Determine what to send
    const shouldReplyComment = ['reply_comment', 'both'].includes(rule.action_type);
    const shouldSendDM = ['reply_dm', 'both'].includes(rule.action_type);

    console.log(`[handleComment]   Action: reply_comment=${shouldReplyComment}, dm=${shouldSendDM}`);

    if (shouldReplyComment) {
      console.log(`[handleComment]   → Scheduling comment reply...`);
      await scheduleAction({
        account, rule, commentId, commentText, commenterId, commenterName,
        mediaId, actionType: 'comment_reply', template: rule.comment_template, platform: 'instagram'
      });
    }

    if (shouldSendDM) {
      console.log(`[handleComment]   → Scheduling DM...`);
      await scheduleAction({
        account, rule, commentId, commentText, commenterId, commenterName,
        mediaId, actionType: 'dm', template: rule.dm_template, platform: 'instagram'
      });
    }
  }

  if (!matchedAny) {
    console.log(`[handleComment] ⚠️ No rules matched this comment`);
    logWebhookEvent('no_rule_match', { comment: commentText, pageId });
  }

  console.log(`[handleComment] ── END ──`);
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

  console.log(`[scheduleAction] Creating activity log: ${logId} (${actionType})`);

  db.prepare(`
    INSERT INTO activity_log (id, account_id, rule_id, event_type, platform, commenter_id, commenter_username, comment_text, media_id, action_taken, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', unixepoch())
  `).run(logId, account.id, rule.id, 'comment_received', platform, commenterId, commenterName, commentText, mediaId, actionType);

  console.log(`[scheduleAction] ✅ Activity log created. Enqueueing to spam queue...`);

  logWebhookEvent('action_scheduled', {
    logId, actionType, commentId,
    commenter: commenterName, comment: commentText,
    account: account.username
  });

  queue.enqueue({
    logId,
    accountId: account.id,
    targetUserId: commenterId,
    execute: async () => {
      console.log(`[execute] ▶️ Executing ${actionType} for log ${logId}`);
      let responseText;

      if (template && template.trim()) {
        responseText = template
          .replace('{{username}}', commenterName || 'there')
          .replace('{{comment}}', commentText);
        console.log(`[execute] Using template: "${responseText}"`);
      } else {
        console.log(`[execute] Generating AI reply...`);
        responseText = await aiService.generateReply(commentText, commenterName, { platform });
        console.log(`[execute] AI generated: "${responseText}"`);
      }

      if (actionType === 'comment_reply') {
        console.log(`[execute] Calling replyToComment(${commentId})...`);
        await instagramService.replyToComment(commentId, responseText, account.access_token);
      } else if (actionType === 'dm') {
        console.log(`[execute] Calling sendDM(${commenterId}, page: ${account.page_id || account.account_id})...`);
        await instagramService.sendDM(commenterId, responseText, account.page_id || account.account_id, account.access_token);
      }

      db.prepare('UPDATE activity_log SET response_text = ? WHERE id = ?').run(responseText, logId);
      console.log(`[execute] ✅ ${actionType} completed successfully`);
    }
  });
}

module.exports = router;

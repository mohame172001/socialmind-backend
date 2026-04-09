const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const queue = require('../queue/spamQueue');
const aiService = require('../services/aiService');
const instagramService = require('../services/instagramService');

const router = express.Router();

// ── Secret check — blocks access without valid token ─────────────────────────
const DEBUG_SECRET = process.env.DEBUG_SECRET || 'socialmind_debug_2024';

function requireSecret(req, res, next) {
  const token = req.headers['x-debug-secret'] || req.query.secret;
  if (token !== DEBUG_SECRET) {
    return res.status(403).json({ error: 'Forbidden. Set x-debug-secret header or ?secret= param.' });
  }
  next();
}

router.use(requireSecret);

// ══════════════════════════════════════════════════════════════════════════════
// POST /debug/test-comment
//
// Simulates a full Instagram comment webhook event.
// Goes through the EXACT same pipeline as a real Meta webhook:
//   1. Account matching (by account_id or page_id)
//   2. Rule matching (trigger_type, keywords, target_media)
//   3. Activity log creation
//   4. Anti-spam queue scheduling
//   5. Action execution (comment reply / DM via Instagram API)
//
// Set skip_execution=true to test everything EXCEPT the Instagram API call.
// ══════════════════════════════════════════════════════════════════════════════
router.post('/test-comment', async (req, res) => {
  const startTime = Date.now();
  const steps = [];

  function step(tag, detail) {
    const entry = { step: tag, detail, ms: Date.now() - startTime };
    steps.push(entry);
    console.log(`[TEST_COMMENT][${tag}] ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }

  try {
    // ── 1. Parse input ──
    const {
      text = 'test comment',
      username = 'test_user',
      user_id = '999999',
      comment_id,
      media_id,
      account_id,          // optional: force specific account by DB id
      skip_execution = false, // true = skip Instagram API calls
      skip_queue = false,     // true = execute immediately, bypass anti-spam delay
    } = req.body;

    const finalCommentId = comment_id || `TEST_${uuidv4().slice(0, 8)}`;
    const finalMediaId = media_id || `MEDIA_TEST_${uuidv4().slice(0, 8)}`;

    step('INPUT', { text, username, user_id, comment_id: finalCommentId, media_id: finalMediaId, skip_execution, skip_queue });

    // ── 2. Find account ──
    let account;
    if (account_id) {
      account = db.prepare('SELECT * FROM accounts WHERE id = ? AND is_active = 1').get(account_id);
    }
    if (!account) {
      // Get first active instagram account
      account = db.prepare('SELECT * FROM accounts WHERE platform = ? AND is_active = 1 LIMIT 1').get('instagram');
    }

    if (!account) {
      step('ACCOUNT', '❌ No active Instagram account found');
      return res.status(400).json({ success: false, steps, error: 'No active Instagram account in DB' });
    }

    step('ACCOUNT', `✅ @${account.username} (id: ${account.account_id}, page: ${account.page_id || 'none'})`);

    // ── 3. Find rules ──
    const rules = db.prepare('SELECT * FROM rules WHERE account_id = ? AND is_active = 1').all(account.id);
    step('RULES_FOUND', `${rules.length} active rule(s)`);

    if (rules.length === 0) {
      step('RULES', '❌ No active rules for this account');
      return res.status(400).json({ success: false, steps, error: 'No active rules' });
    }

    // ── 4. Match rules ──
    const actions = [];

    for (const rule of rules) {
      // Media filter
      if (rule.target_media_id && rule.target_media_id !== finalMediaId) {
        step('TEST_RULE_MATCH', `⏭️ "${rule.name}" — media mismatch (wants ${rule.target_media_id})`);
        continue;
      }

      // Trigger filter
      let matched = false;
      if (rule.trigger_type === 'any') {
        matched = true;
      } else if (rule.trigger_type === 'keyword') {
        const keywords = JSON.parse(rule.keywords || '[]');
        matched = keywords.some(kw => text.toLowerCase().includes(kw.toLowerCase()));
      }

      if (!matched) {
        step('TEST_RULE_MATCH', `⏭️ "${rule.name}" — trigger not matched`);
        continue;
      }

      step('TEST_RULE_MATCH', `✅ "${rule.name}" (trigger: ${rule.trigger_type}, action: ${rule.action_type})`);

      const shouldReply = ['reply_comment', 'both'].includes(rule.action_type);
      const shouldDM = ['reply_dm', 'both'].includes(rule.action_type);

      if (shouldReply) actions.push({ rule, actionType: 'comment_reply', template: rule.comment_template });
      if (shouldDM) actions.push({ rule, actionType: 'dm', template: rule.dm_template });
    }

    if (actions.length === 0) {
      step('MATCH_RESULT', '⚠️ Rules exist but none matched this comment');
      return res.json({ success: true, steps, matched: false, actions_created: 0 });
    }

    step('MATCH_RESULT', `${actions.length} action(s) to execute`);

    // ── 5. Create activity logs + execute ──
    const results = [];

    for (const action of actions) {
      const logId = uuidv4();

      // Create activity log (same as real flow)
      db.prepare(`
        INSERT INTO activity_log (id, account_id, rule_id, event_type, platform, commenter_id, commenter_username, comment_text, media_id, action_taken, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', unixepoch())
      `).run(logId, account.id, action.rule.id, 'test_comment', 'instagram', user_id, username, text, finalMediaId, action.actionType);

      step('TEST_ACTION', `📝 Activity log created: ${logId} (${action.actionType})`);

      // Generate response text
      let responseText;
      if (action.template && action.template.trim()) {
        responseText = action.template
          .replace('{{username}}', username || 'there')
          .replace('{{comment}}', text);
        step('TEST_ACTION', `📋 Template → "${responseText}"`);
      } else {
        try {
          responseText = await aiService.generateReply(text, username, { platform: 'instagram' });
          step('TEST_ACTION', `🤖 AI generated → "${responseText}"`);
        } catch (aiErr) {
          responseText = `Thanks for your comment, @${username}!`;
          step('TEST_ACTION', `⚠️ AI failed (${aiErr.message}), using fallback → "${responseText}"`);
        }
      }

      if (skip_execution) {
        // Mark as skipped — don't call Instagram API
        db.prepare('UPDATE activity_log SET status = ?, response_text = ?, error_message = ? WHERE id = ?')
          .run('skipped', responseText, 'TEST MODE: skip_execution=true', logId);
        step('TEST_ACTION', `⏭️ ${action.actionType} SKIPPED (skip_execution=true)`);

        results.push({ logId, actionType: action.actionType, responseText, status: 'skipped' });
      } else if (skip_queue) {
        // Execute immediately — bypass anti-spam delay
        step('TEST_ACTION', `⚡ Executing ${action.actionType} IMMEDIATELY (skip_queue=true)...`);

        try {
          if (action.actionType === 'comment_reply') {
            await instagramService.replyToComment(finalCommentId, responseText, account);
          } else if (action.actionType === 'dm') {
            await instagramService.sendDM({
              commenterId: user_id,
              commentId: finalCommentId,
              message: responseText,
              account,
            });
          }

          db.prepare('UPDATE activity_log SET status = ?, response_text = ?, executed_at = unixepoch() WHERE id = ?')
            .run('sent', responseText, logId);
          step('TEST_ACTION', `✅ ${action.actionType} SENT successfully`);
          results.push({ logId, actionType: action.actionType, responseText, status: 'sent' });
        } catch (execErr) {
          db.prepare('UPDATE activity_log SET status = ?, response_text = ?, error_message = ?, executed_at = unixepoch() WHERE id = ?')
            .run('failed', responseText, execErr.message, logId);
          step('TEST_ACTION', `❌ ${action.actionType} FAILED: ${execErr.message}`);
          results.push({ logId, actionType: action.actionType, responseText, status: 'failed', error: execErr.message });
        }
      } else {
        // Normal flow — enqueue with anti-spam delay
        queue.enqueue({
          logId,
          accountId: account.id,
          targetUserId: user_id,
          execute: async () => {
            console.log(`[TEST_EXECUTE] ▶️ Executing ${action.actionType} for log ${logId}`);
            try {
              if (action.actionType === 'comment_reply') {
                await instagramService.replyToComment(finalCommentId, responseText, account);
              } else {
                await instagramService.sendDM({
                  commenterId: user_id,
                  commentId: finalCommentId,
                  message: responseText,
                  account,
                });
              }
              db.prepare('UPDATE activity_log SET status = ?, response_text = ?, executed_at = unixepoch() WHERE id = ?')
                .run('sent', responseText, logId);
              console.log(`[TEST_EXECUTE] ✅ ${action.actionType} completed`);
            } catch (err) {
              db.prepare('UPDATE activity_log SET status = ?, error_message = ?, executed_at = unixepoch() WHERE id = ?')
                .run('failed', err.message, logId);
              console.log(`[TEST_EXECUTE] ❌ ${action.actionType} failed: ${err.message}`);
            }
          }
        });
        step('TEST_ACTION', `📦 ${action.actionType} ENQUEUED (anti-spam delay applies)`);
        results.push({ logId, actionType: action.actionType, responseText, status: 'queued' });
      }
    }

    step('DONE', `${results.length} action(s) processed`);

    return res.json({
      success: true,
      simulated: true,
      account: `@${account.username}`,
      comment: { id: finalCommentId, text, from: username, media_id: finalMediaId },
      matched_rules: actions.map(a => ({ name: a.rule.name, action: a.actionType })),
      results,
      steps,
      duration_ms: Date.now() - startTime
    });

  } catch (err) {
    step('ERROR', `💥 ${err.message}`);
    console.error('[TEST_COMMENT] Unhandled error:', err);
    return res.status(500).json({ success: false, steps, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /debug/status — quick system health for debugging
// ══════════════════════════════════════════════════════════════════════════════
router.get('/status', (req, res) => {
  const accounts = db.prepare('SELECT id, platform, username, account_id, page_id, auth_type, is_active FROM accounts').all();
  const rules = db.prepare('SELECT id, name, account_id, trigger_type, action_type, is_active FROM rules').all();
  const recentActivity = db.prepare('SELECT id, event_type, platform, commenter_username, comment_text, action_taken, status, created_at FROM activity_log ORDER BY created_at DESC LIMIT 10').all();
  const queueStatus = queue.getStats ? queue.getStats() : 'unknown';

  res.json({
    accounts,
    rules,
    recent_activity: recentActivity,
    queue: queueStatus,
    timestamp: new Date().toISOString()
  });
});

module.exports = router;

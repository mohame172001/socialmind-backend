const express = require('express');
const db = require('../db');

const router = express.Router();

const USER_EDITABLE_KEYS = [
  'anthropic_api_key',
  'ai_prompt_template',
  'min_delay_seconds',
  'max_delay_seconds',
  'max_replies_per_hour',
  'user_cooldown_minutes',
  'tiktok_client_key',
  'tiktok_client_secret'
];

const LOCKED_INTEGRATION_KEYS = [
  'meta_app_id',
  'meta_app_secret',
  'meta_login_config_id'
];

const ENV_MAP = {
  meta_app_id:            'META_APP_ID',
  meta_app_secret:        'META_APP_SECRET',
  meta_login_config_id:   'META_LOGIN_CONFIG_ID',
  tiktok_client_key:      'TIKTOK_CLIENT_KEY',
  tiktok_client_secret:   'TIKTOK_CLIENT_SECRET',
  anthropic_api_key:      'ANTHROPIC_API_KEY',
};

const MASKED_KEYS = ['anthropic_api_key', 'tiktok_client_secret'];
const SECRET_KEYS = ['anthropic_api_key', 'tiktok_client_secret'];

function getDbValue(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value || '';
}

function effectiveValue(key, dbValue) {
  const envKey = ENV_MAP[key];
  if (envKey && process.env[envKey]) return process.env[envKey];
  return dbValue;
}

function maskValue(value) {
  if (!value) return '';
  if (value.length <= 8) return `${value.slice(0, 2)}...`;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function getSettingStatus(key) {
  const envKey = ENV_MAP[key];
  if (envKey && process.env[envKey]) return { set: true, source: 'env' };
  if (getDbValue(key)) return { set: true, source: 'db' };
  return { set: false, source: 'none' };
}

function isMaskedSecretPlaceholder(value) {
  return typeof value === 'string' && value.includes('...');
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};

  for (const row of rows) {
    if (LOCKED_INTEGRATION_KEYS.includes(row.key)) continue;

    const val = effectiveValue(row.key, row.value);
    if (MASKED_KEYS.includes(row.key) && val) {
      settings[row.key] = maskValue(val);
    } else {
      settings[row.key] = val;
    }
  }

  res.json(settings);
});

router.put('/', (req, res) => {
  const updates = req.body;
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())');

  const updatedKeys = [];
  const skippedEmptySecrets = [];
  const ignoredLockedKeys = [];
  const ignoredMaskedSecrets = [];

  const updateMany = db.transaction((incoming) => {
    for (const [key, value] of Object.entries(incoming)) {
      if (LOCKED_INTEGRATION_KEYS.includes(key)) {
        ignoredLockedKeys.push(key);
        continue;
      }

      if (!USER_EDITABLE_KEYS.includes(key)) continue;

      const strVal = String(value ?? '').trim();

      if (SECRET_KEYS.includes(key) && !strVal) {
        skippedEmptySecrets.push(key);
        continue;
      }

      if (SECRET_KEYS.includes(key) && isMaskedSecretPlaceholder(strVal)) {
        ignoredMaskedSecrets.push(key);
        continue;
      }

      stmt.run(key, strVal);
      updatedKeys.push(key);
    }
  });

  updateMany(updates);

  console.log('[Settings] Updated:', updatedKeys.join(', ') || 'none');
  if (skippedEmptySecrets.length) console.log('[Settings] Skipped empty secrets:', skippedEmptySecrets.join(', '));
  if (ignoredLockedKeys.length) console.log('[Settings] Ignored locked keys:', ignoredLockedKeys.join(', '));
  if (ignoredMaskedSecrets.length) console.log('[Settings] Ignored masked secrets:', ignoredMaskedSecrets.join(', '));

  res.json({
    success: true,
    updated: updatedKeys,
    skipped_empty_secrets: skippedEmptySecrets,
    ignored_locked_keys: ignoredLockedKeys,
    ignored_masked_secrets: ignoredMaskedSecrets
  });
});

router.get('/status', (req, res) => {
  const metaAppId = getSettingStatus('meta_app_id');
  const metaAppSecret = getSettingStatus('meta_app_secret');
  const anthropicApiKey = getSettingStatus('anthropic_api_key');
  const tiktokClientKey = getSettingStatus('tiktok_client_key');

  const backendUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `${req.protocol}://${req.get('host')}`;

  const integrationSource = metaAppId.source === 'env' || metaAppSecret.source === 'env'
    ? 'env'
    : (metaAppId.set || metaAppSecret.set ? 'db' : 'none');

  const instagramStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active
    FROM accounts
    WHERE platform = 'instagram'
  `).get();

  res.json({
    meta_app_id: metaAppId,
    meta_app_secret: metaAppSecret,
    meta_login_config_id: getSettingStatus('meta_login_config_id'),
    anthropic_api_key: anthropicApiKey,
    tiktok_client_key: tiktokClientKey,
    oauth_ready: metaAppId.set && metaAppSecret.set,
    integration_locked: true,
    integration_source_of_truth: integrationSource,
    integration_source_label: integrationSource === 'env'
      ? 'Backend environment variables'
      : integrationSource === 'db'
        ? 'Backend database (legacy fallback)'
        : 'Missing',
    meta_app_id_display: maskValue(effectiveValue('meta_app_id', getDbValue('meta_app_id'))),
    meta_app_secret_display: maskValue(effectiveValue('meta_app_secret', getDbValue('meta_app_secret'))),
    instagram_accounts_connected: instagramStats?.total || 0,
    instagram_accounts_active: instagramStats?.active || 0,
    canonical_redirect_uri: `${backendUrl}/api/oauth/instagram/callback`,
    canonical_app_domain: new URL(backendUrl).hostname,
    canonical_webhook_url: `${backendUrl}/webhooks/instagram`,
  });
});

router.post('/chat', async (req, res) => {
  const { command, history = [] } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });

  const apiKey = db.prepare('SELECT value FROM settings WHERE key=?').get('anthropic_api_key')?.value;
  if (!apiKey) return res.json({ response: 'Ù„Ù… ÙŠØªÙ… Ø¶Ø¨Ø· Ù…ÙØªØ§Ø­ Ø§Ù„Ø°ÙƒØ§Ø¡ Ø§Ù„Ø§ØµØ·Ù†Ø§Ø¹ÙŠ. Ø±ÙˆØ­ Settings ÙˆØ£Ø¶ÙÙ‡.' });

  const accounts = db.prepare('SELECT platform, username, is_active FROM accounts').all();
  const stats = db.prepare(`SELECT
    COUNT(CASE WHEN status='sent'    AND created_at>(unixepoch()-86400) THEN 1 END) sent_today,
    COUNT(CASE WHEN status='failed'  AND created_at>(unixepoch()-86400) THEN 1 END) failed_today,
    COUNT(CASE WHEN status='pending'                                     THEN 1 END) pending
    FROM activity_log`).get();

  const accText = accounts.length
    ? accounts.map((a) => `@${a.username} (${a.platform === 'instagram' ? 'Ø§Ù†Ø³ØªØ¬Ø±Ø§Ù…' : 'ØªÙŠÙƒ ØªÙˆÙƒ'})`).join(', ')
    : 'Ù„Ø§ ÙŠÙˆØ¬Ø¯ Ø­Ø³Ø§Ø¨Ø§Øª';

  const system = `Ø£Ù†Øª "Ù…ÙŠÙ†Ø¯ÙŠ"ØŒ Ù…Ø³Ø§Ø¹Ø¯ Ø³ÙˆØ´ÙŠØ§Ù„ Ù…ÙŠØ¯ÙŠØ§ Ø°ÙƒÙŠ ÙˆÙˆØ¯ÙˆØ¯. ØªØªÙƒÙ„Ù… Ø¹Ø±Ø¨ÙŠ Ù…ØµØ±ÙŠ Ø·Ø¨ÙŠØ¹ÙŠ.
Ø­Ø§Ù„Ø© Ø§Ù„ØªØ·Ø¨ÙŠÙ‚: ${accText} | Ø£ÙØ±Ø³Ù„ Ø§Ù„ÙŠÙˆÙ…: ${stats?.sent_today||0} | ÙØ´Ù„: ${stats?.failed_today||0} | Ø§Ù†ØªØ¸Ø§Ø±: ${stats?.pending||0}
Ø±Ø¯ Ø¨Ø´ÙƒÙ„ Ø·Ø¨ÙŠØ¹ÙŠ ÙˆÙ…ØªÙØ§Ø¹Ù„ Ø¹Ù„Ù‰ Ø£ÙŠ Ø³Ø¤Ø§Ù„ - Ù…Ø´ Ù„Ø§Ø²Ù… ÙŠÙƒÙˆÙ† Ø¹Ù† Ø§Ù„ØªØ·Ø¨ÙŠÙ‚ ÙÙ‚Ø·.`;

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const msgs = [...history.slice(-10), { role: 'user', content: command }];
    const result = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 400, system, messages: msgs
    });
    res.json({ response: result.content[0].text.trim() });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ response: 'Ø­ØµÙ„ Ø®Ø·Ø£ØŒ Ø¬Ø±Ø¨ ØªØ§Ù†ÙŠ.' });
  }
});

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

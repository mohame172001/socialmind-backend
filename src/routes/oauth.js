const express = require('express');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

// ENV var mapping: settings DB key → process.env key
const ENV_MAP = {
  meta_app_id:          'META_APP_ID',
  meta_app_secret:      'META_APP_SECRET',
  tiktok_client_key:    'TIKTOK_CLIENT_KEY',
  tiktok_client_secret: 'TIKTOK_CLIENT_SECRET',
  anthropic_api_key:    'ANTHROPIC_API_KEY',
};

// Priority: process.env → settings DB
function getSetting(key) {
  const envKey = ENV_MAP[key];
  if (envKey && process.env[envKey]) {
    return process.env[envKey];
  }
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return (row && row.value) ? row.value : null;
}

function httpsRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────
// INSTAGRAM OAuth (via Facebook Login)
// ─────────────────────────────────────────────

// Valid Meta OAuth scopes (NO deprecated manage_pages!)
const META_OAUTH_SCOPES = [
  'instagram_basic',
  'instagram_manage_comments',
  'instagram_manage_messages',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata'
].join(',');

// Diagnostic endpoint — shows the exact auth URL without redirecting
router.get('/instagram/debug-auth-url', (req, res) => {
  const appId = getSetting('meta_app_id');
  if (!appId) {
    return res.json({
      error: 'Meta App ID not configured',
      meta_app_id: null,
      note: 'OAuth flow will NOT run — frontend opens manual form instead'
    });
  }

  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `${req.protocol}://${req.get('host')}`;

  const redirectUri = `${baseUrl}/api/oauth/instagram/callback`;
  const scopeRaw = META_OAUTH_SCOPES;
  const scopeEncoded = encodeURIComponent(scopeRaw);

  const authUrl = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopeEncoded}&state=DEBUG_STATE&response_type=code`;

  res.json({
    source_file: 'backend/src/routes/oauth.js',
    source_function: 'GET /api/oauth/instagram/connect',
    meta_app_id: appId,
    redirect_uri: redirectUri,
    scope_raw: scopeRaw,
    scope_encoded: scopeEncoded,
    scope_list: scopeRaw.split(','),
    contains_manage_pages: scopeRaw.includes('manage_pages'),
    final_auth_url: authUrl,
    runtime_timestamp: new Date().toISOString()
  });
});

// Step 1: Redirect user to Facebook OAuth
router.get('/instagram/connect', (req, res) => {
  const appId = getSetting('meta_app_id');
  if (!appId) {
    return res.status(400).json({ error: 'Meta App ID not configured. Go to Settings first.' });
  }

  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `${req.protocol}://${req.get('host')}`;

  const redirectUri = encodeURIComponent(`${baseUrl}/api/oauth/instagram/callback`);
  const scope = encodeURIComponent(META_OAUTH_SCOPES);
  const state = uuidv4();

  // Store state temporarily (simple in-memory for now)
  if (!global.oauthStates) global.oauthStates = {};
  global.oauthStates[state] = { createdAt: Date.now() };

  const authUrl = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${appId}&redirect_uri=${redirectUri}&scope=${scope}&state=${state}&response_type=code`;

  // ===== RUNTIME LOGGING =====
  console.log('========== OAUTH DEBUG ==========');
  console.log('[OAuth] Source: backend/src/routes/oauth.js → GET /instagram/connect');
  console.log('[OAuth] Meta App ID:', appId);
  console.log('[OAuth] Scope (raw):', META_OAUTH_SCOPES);
  console.log('[OAuth] Scope (encoded):', scope);
  console.log('[OAuth] Contains manage_pages:', META_OAUTH_SCOPES.includes('manage_pages'));
  console.log('[OAuth] Redirect URI:', decodeURIComponent(redirectUri));
  console.log('[OAuth] FULL AUTH URL:', authUrl);
  console.log('=================================');

  res.redirect(authUrl);
});

// Step 2: Handle callback from Facebook
router.get('/instagram/callback', async (req, res) => {
  const { code, state, error } = req.query;

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

  console.log('[OAuth][STEP 2] Callback received');
  console.log('[OAuth][STEP 2] code:', code ? `${code.substring(0, 20)}...` : 'MISSING');
  console.log('[OAuth][STEP 2] state:', state);
  console.log('[OAuth][STEP 2] error:', error || 'none');

  if (error) {
    console.log('[OAuth][STEP 2] ❌ Meta returned error:', error);
    return res.redirect(`${frontendUrl}/accounts?oauth_error=${encodeURIComponent(error)}`);
  }

  // Validate state
  if (!global.oauthStates || !global.oauthStates[state]) {
    console.log('[OAuth][STEP 2] ❌ Invalid state token');
    return res.redirect(`${frontendUrl}/accounts?oauth_error=invalid_state`);
  }
  delete global.oauthStates[state];
  console.log('[OAuth][STEP 2] ✅ State validated');

  try {
    const appId = getSetting('meta_app_id');
    const appSecret = getSetting('meta_app_secret');
    console.log('[OAuth][STEP 3] App ID:', appId);
    console.log('[OAuth][STEP 3] App Secret:', appSecret ? `${appSecret.substring(0, 6)}...` : 'MISSING!');

    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : `${req.protocol}://${req.get('host')}`;

    const redirectUri = `${baseUrl}/api/oauth/instagram/callback`;
    console.log('[OAuth][STEP 3] Redirect URI for token exchange:', redirectUri);

    // Exchange code for access token
    console.log('[OAuth][STEP 4] Exchanging code for short-lived token...');
    const tokenUrl = `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${code}`;
    const tokenData = await httpsRequest(tokenUrl);

    if (!tokenData.access_token) {
      console.log('[OAuth][STEP 4] ❌ Token exchange failed:', JSON.stringify(tokenData));
      throw new Error(tokenData.error?.message || 'Failed to get access token');
    }

    const shortToken = tokenData.access_token;
    console.log('[OAuth][STEP 4] ✅ Got short-lived token:', `${shortToken.substring(0, 20)}...`);

    // Exchange for long-lived token
    console.log('[OAuth][STEP 5] Exchanging for long-lived token...');
    const longTokenUrl = `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortToken}`;
    const longTokenData = await httpsRequest(longTokenUrl);
    const longToken = longTokenData.access_token || shortToken;
    console.log('[OAuth][STEP 5] ✅ Long-lived token:', `${longToken.substring(0, 20)}...`);
    if (longTokenData.expires_in) console.log('[OAuth][STEP 5] Expires in:', longTokenData.expires_in, 'seconds');

    // Get user's Facebook Pages
    console.log('[OAuth][STEP 6] Fetching Facebook Pages...');
    const pagesData = await httpsRequest(`https://graph.facebook.com/v19.0/me/accounts?access_token=${longToken}&fields=id,name,instagram_business_account`);
    console.log('[OAuth][STEP 6] Pages response:', JSON.stringify(pagesData));

    if (!pagesData.data || pagesData.data.length === 0) {
      throw new Error('No Facebook Pages found. Make sure your Instagram is connected to a Facebook Page.');
    }
    console.log('[OAuth][STEP 6] ✅ Found', pagesData.data.length, 'page(s)');

    let connectedCount = 0;

    for (const page of pagesData.data) {
      console.log(`[OAuth][STEP 7] Page: "${page.name}" (ID: ${page.id}) → IG: ${page.instagram_business_account ? page.instagram_business_account.id : 'NONE'}`);
      if (!page.instagram_business_account) continue;

      const igId = page.instagram_business_account.id;

      // Get page-specific token
      console.log(`[OAuth][STEP 8] Getting Page Access Token for page ${page.id}...`);
      const pageTokenData = await httpsRequest(`https://graph.facebook.com/v19.0/${page.id}?fields=access_token&access_token=${longToken}`);
      const pageToken = pageTokenData.access_token || longToken;
      console.log(`[OAuth][STEP 8] ✅ Page token: ${pageToken.substring(0, 20)}...`);

      // Get Instagram username
      console.log(`[OAuth][STEP 9] Fetching IG username for ${igId}...`);
      const igData = await httpsRequest(`https://graph.facebook.com/v19.0/${igId}?fields=username,name&access_token=${pageToken}`);
      const username = igData.username || igData.name || `ig_${igId}`;
      console.log(`[OAuth][STEP 9] ✅ IG username: @${username}`);

      // Upsert account
      const id = uuidv4();
      try {
        db.prepare(`
          INSERT INTO accounts (id, platform, account_id, username, access_token, page_id, is_active)
          VALUES (?, 'instagram', ?, ?, ?, ?, 1)
          ON CONFLICT(platform, account_id) DO UPDATE SET
            username = excluded.username,
            access_token = excluded.access_token,
            page_id = excluded.page_id,
            is_active = 1,
            updated_at = unixepoch()
        `).run(id, igId, username, pageToken, page.id);
        connectedCount++;
        console.log(`[OAuth][STEP 10] ✅ Saved account: @${username} (IG: ${igId}, Page: ${page.id})`);
      } catch (e) {
        console.error(`[OAuth][STEP 10] ❌ Error saving account:`, e.message);
      }
    }

    if (connectedCount === 0) {
      throw new Error('No Instagram Business accounts found. Make sure your Instagram is set to Business/Creator mode and linked to a Facebook Page.');
    }

    console.log(`[OAuth] ✅✅✅ SUCCESS! Connected ${connectedCount} account(s)`);
    res.redirect(`${frontendUrl}/accounts?oauth_success=${connectedCount}`);
  } catch (err) {
    console.error('[OAuth] ❌❌❌ FAILED:', err.message);
    res.redirect(`${frontendUrl}/accounts?oauth_error=${encodeURIComponent(err.message)}`);
  }
});

// ─────────────────────────────────────────────
// TIKTOK OAuth
// ─────────────────────────────────────────────

router.get('/tiktok/connect', (req, res) => {
  const clientKey = getSetting('tiktok_client_key');
  if (!clientKey) {
    return res.status(400).json({ error: 'TikTok Client Key not configured. Go to Settings first.' });
  }

  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `${req.protocol}://${req.get('host')}`;

  const redirectUri = encodeURIComponent(`${baseUrl}/api/oauth/tiktok/callback`);
  const state = uuidv4();
  const scope = encodeURIComponent('user.info.basic,video.list,comment.list,comment.create');

  if (!global.oauthStates) global.oauthStates = {};
  global.oauthStates[state] = { createdAt: Date.now() };

  const authUrl = `https://www.tiktok.com/v2/auth/authorize?client_key=${clientKey}&response_type=code&scope=${scope}&redirect_uri=${redirectUri}&state=${state}`;
  res.redirect(authUrl);
});

router.get('/tiktok/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

  if (error) return res.redirect(`${frontendUrl}/accounts?oauth_error=${encodeURIComponent(error)}`);

  if (!global.oauthStates || !global.oauthStates[state]) {
    return res.redirect(`${frontendUrl}/accounts?oauth_error=invalid_state`);
  }
  delete global.oauthStates[state];

  try {
    const clientKey = getSetting('tiktok_client_key');
    const clientSecret = getSetting('tiktok_client_secret');

    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : `${req.protocol}://${req.get('host')}`;

    const redirectUri = `${baseUrl}/api/oauth/tiktok/callback`;

    // Exchange code for token
    const body = `code=${code}&client_key=${clientKey}&client_secret=${clientSecret}&grant_type=authorization_code&redirect_uri=${encodeURIComponent(redirectUri)}`;
    const tokenData = await httpsRequest('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, body);

    if (!tokenData.access_token) {
      throw new Error(tokenData.error_description || 'Failed to get TikTok access token');
    }

    // Get user info
    const userRes = await httpsRequest('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });

    const user = userRes.data?.user;
    const openId = user?.open_id || tokenData.open_id;
    const username = user?.display_name || user?.username || `tiktok_${openId}`;

    const id = uuidv4();
    db.prepare(`
      INSERT INTO accounts (id, platform, account_id, username, access_token, is_active)
      VALUES (?, 'tiktok', ?, ?, ?, 1)
      ON CONFLICT(platform, account_id) DO UPDATE SET
        username = excluded.username,
        access_token = excluded.access_token,
        is_active = 1,
        updated_at = unixepoch()
    `).run(id, openId, username, tokenData.access_token);

    res.redirect(`${frontendUrl}/accounts?oauth_success=1`);
  } catch (err) {
    console.error('[OAuth] TikTok error:', err.message);
    res.redirect(`${frontendUrl}/accounts?oauth_error=${encodeURIComponent(err.message)}`);
  }
});

module.exports = router;

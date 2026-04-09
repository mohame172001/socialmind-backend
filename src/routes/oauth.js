const express = require('express');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

// ─────────────────────────────────────────────
// Centralized Meta OAuth Configuration
// ─────────────────────────────────────────────
const META_API_VERSION = 'v22.0';

// ENV var mapping: settings DB key → process.env key
const ENV_MAP = {
  meta_app_id:          'META_APP_ID',
  meta_app_secret:      'META_APP_SECRET',
  meta_login_config_id: 'META_LOGIN_CONFIG_ID',
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

// Canonical production base URL — single source of truth
function getBaseUrl(req) {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  return `${req.protocol}://${req.get('host')}`;
}

// Canonical redirect URI — single source of truth, used everywhere
function getRedirectUri(req) {
  return `${getBaseUrl(req)}/api/oauth/instagram/callback`;
}

// Frontend URL for post-OAuth redirect — NO localhost fallback in production
function getFrontendUrl(stateData) {
  // 1. Explicit ENV (always wins)
  if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL;
  // 2. Captured from the request that initiated the OAuth flow
  if (stateData?.frontendOrigin) return stateData.frontendOrigin;
  // 3. Dev-only fallback (safe: only applies when no ENV and no referer)
  return 'http://localhost:5173';
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

// Valid Meta OAuth scopes
const META_OAUTH_SCOPES = [
  'instagram_basic',
  'instagram_manage_comments',
  'instagram_manage_messages',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata'
].join(',');

// Build the Facebook OAuth authorization URL
// Supports BOTH standard Facebook Login and Facebook Login for Business
function buildAuthUrl(appId, redirectUri, state, configId) {
  if (configId) {
    // Facebook Login for Business — uses config_id (redirect_uri and scopes are inside the configuration)
    return `https://www.facebook.com/${META_API_VERSION}/dialog/oauth?client_id=${appId}&config_id=${configId}&state=${state}&response_type=code`;
  }
  // Standard Facebook Login — redirect_uri and scope in URL
  const encodedRedirect = encodeURIComponent(redirectUri);
  const encodedScope = encodeURIComponent(META_OAUTH_SCOPES);
  return `https://www.facebook.com/${META_API_VERSION}/dialog/oauth?client_id=${appId}&redirect_uri=${encodedRedirect}&scope=${encodedScope}&state=${state}&response_type=code`;
}

// ── Diagnostic endpoint ─────────────────────────────────────────────────────
router.get('/instagram/debug-auth-url', (req, res) => {
  const appId = getSetting('meta_app_id');
  const configId = getSetting('meta_login_config_id');
  const redirectUri = getRedirectUri(req);

  if (!appId) {
    return res.json({
      error: 'Meta App ID not configured',
      meta_app_id: null,
    });
  }

  const state = 'DEBUG_STATE';
  const authUrl = buildAuthUrl(appId, redirectUri, state, configId);

  res.json({
    source_file: 'backend/src/routes/oauth.js',
    meta_api_version: META_API_VERSION,
    meta_app_id: appId,
    meta_login_config_id: configId || null,
    flow_type: configId ? 'facebook_login_for_business' : 'standard_facebook_login',
    redirect_uri: redirectUri,
    scope_raw: META_OAUTH_SCOPES,
    scope_list: META_OAUTH_SCOPES.split(','),
    final_auth_url: authUrl,
    callback_route: '/api/oauth/instagram/callback',
    base_url_source: process.env.RAILWAY_PUBLIC_DOMAIN ? 'RAILWAY_PUBLIC_DOMAIN env' : 'req.protocol + req.host',
    railway_public_domain: process.env.RAILWAY_PUBLIC_DOMAIN || '(not set)',
    runtime_timestamp: new Date().toISOString(),
    meta_dashboard_checklist: {
      '1_app_domains': `Add: ${new URL(redirectUri).hostname}`,
      '2_valid_oauth_redirect_uris': redirectUri,
      '3_client_oauth_login': 'ON',
      '4_web_oauth_login': 'ON',
      '5_enforce_https': 'ON',
      '6_if_facebook_login_for_business': 'Create a Login Configuration with the redirect URI and scopes, then set META_LOGIN_CONFIG_ID env var or meta_login_config_id setting'
    }
  });
});

// ── Step 1: Redirect user to Facebook OAuth ─────────────────────────────────
router.get('/instagram/connect', (req, res) => {
  const appId = getSetting('meta_app_id');
  if (!appId) {
    return res.status(400).json({ error: 'Meta App ID not configured. Go to Settings first.' });
  }

  const configId = getSetting('meta_login_config_id');
  const redirectUri = getRedirectUri(req);
  const state = uuidv4();

  // Capture the frontend origin from the request that initiated the flow
  const referer = req.get('referer');
  const frontendOrigin = referer ? new URL(referer).origin : null;

  if (!global.oauthStates) global.oauthStates = {};
  global.oauthStates[state] = { createdAt: Date.now(), frontendOrigin };

  const authUrl = buildAuthUrl(appId, redirectUri, state, configId);

  console.log('========== OAUTH CONNECT ==========');
  console.log('[OAuth] API Version:', META_API_VERSION);
  console.log('[OAuth] Flow:', configId ? 'Facebook Login for Business (config_id)' : 'Standard Facebook Login');
  console.log('[OAuth] Meta App ID:', appId);
  console.log('[OAuth] Config ID:', configId || '(none — standard flow)');
  console.log('[OAuth] Redirect URI:', redirectUri);
  console.log('[OAuth] Frontend origin:', frontendOrigin || '(no referer)');
  console.log('[OAuth] Auth URL:', authUrl);
  console.log('====================================');

  res.redirect(authUrl);
});

// ── Step 2: Handle callback from Facebook ───────────────────────────────────
router.get('/instagram/callback', async (req, res) => {
  const { code, state, error } = req.query;

  const stateData = global.oauthStates?.[state];
  const frontendUrl = getFrontendUrl(stateData);

  console.log('[OAuth][CALLBACK] code:', code ? `${code.substring(0, 20)}...` : 'MISSING');
  console.log('[OAuth][CALLBACK] state:', state);
  console.log('[OAuth][CALLBACK] error:', error || 'none');
  console.log('[OAuth][CALLBACK] frontendUrl:', frontendUrl);

  if (error) {
    console.log('[OAuth][CALLBACK] ❌ Meta returned error:', error);
    return res.redirect(`${frontendUrl}/accounts?oauth_error=${encodeURIComponent(error)}`);
  }

  if (!stateData) {
    console.log('[OAuth][CALLBACK] ❌ Invalid state token');
    return res.redirect(`${frontendUrl}/accounts?oauth_error=invalid_state`);
  }
  delete global.oauthStates[state];

  try {
    const appId = getSetting('meta_app_id');
    const appSecret = getSetting('meta_app_secret');
    const redirectUri = getRedirectUri(req);

    console.log('[OAuth][TOKEN] App ID:', appId);
    console.log('[OAuth][TOKEN] App Secret:', appSecret ? `${appSecret.substring(0, 6)}...` : 'MISSING!');
    console.log('[OAuth][TOKEN] Redirect URI:', redirectUri);

    // Exchange code for access token
    const tokenUrl = `https://graph.facebook.com/${META_API_VERSION}/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${code}`;
    const tokenData = await httpsRequest(tokenUrl);

    if (!tokenData.access_token) {
      console.log('[OAuth][TOKEN] ❌ Failed:', JSON.stringify(tokenData));
      throw new Error(tokenData.error?.message || 'Failed to get access token');
    }

    const shortToken = tokenData.access_token;
    console.log('[OAuth][TOKEN] ✅ Short-lived token:', `${shortToken.substring(0, 20)}...`);

    // Exchange for long-lived token
    const longTokenUrl = `https://graph.facebook.com/${META_API_VERSION}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortToken}`;
    const longTokenData = await httpsRequest(longTokenUrl);
    const longToken = longTokenData.access_token || shortToken;
    console.log('[OAuth][TOKEN] ✅ Long-lived token:', `${longToken.substring(0, 20)}...`);

    // Get user's Facebook Pages
    const pagesData = await httpsRequest(`https://graph.facebook.com/${META_API_VERSION}/me/accounts?access_token=${longToken}&fields=id,name,instagram_business_account`);

    if (!pagesData.data || pagesData.data.length === 0) {
      throw new Error('No Facebook Pages found. Make sure your Instagram is connected to a Facebook Page.');
    }
    console.log('[OAuth][PAGES] Found', pagesData.data.length, 'page(s)');

    let connectedCount = 0;

    for (const page of pagesData.data) {
      console.log(`[OAuth][PAGE] "${page.name}" (${page.id}) → IG: ${page.instagram_business_account ? page.instagram_business_account.id : 'NONE'}`);
      if (!page.instagram_business_account) continue;

      const igId = page.instagram_business_account.id;

      // Get page-specific token
      const pageTokenData = await httpsRequest(`https://graph.facebook.com/${META_API_VERSION}/${page.id}?fields=access_token&access_token=${longToken}`);
      const pageToken = pageTokenData.access_token || longToken;

      // Get Instagram username
      const igData = await httpsRequest(`https://graph.facebook.com/${META_API_VERSION}/${igId}?fields=username,name&access_token=${pageToken}`);
      const username = igData.username || igData.name || `ig_${igId}`;
      console.log(`[OAuth][IG] @${username} (${igId})`);

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
        console.log(`[OAuth][SAVE] ✅ @${username}`);
      } catch (e) {
        console.error(`[OAuth][SAVE] ❌`, e.message);
      }
    }

    if (connectedCount === 0) {
      throw new Error('No Instagram Business accounts found. Make sure your Instagram is set to Business/Creator mode and linked to a Facebook Page.');
    }

    console.log(`[OAuth] ✅ Connected ${connectedCount} account(s)`);
    res.redirect(`${frontendUrl}/accounts?oauth_success=${connectedCount}`);
  } catch (err) {
    console.error('[OAuth] ❌ FAILED:', err.message);
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

  const baseUrl = getBaseUrl(req);
  const redirectUri = encodeURIComponent(`${baseUrl}/api/oauth/tiktok/callback`);
  const state = uuidv4();
  const scope = encodeURIComponent('user.info.basic,video.list,comment.list,comment.create');

  const referer = req.get('referer');
  const frontendOrigin = referer ? new URL(referer).origin : null;

  if (!global.oauthStates) global.oauthStates = {};
  global.oauthStates[state] = { createdAt: Date.now(), frontendOrigin };

  const authUrl = `https://www.tiktok.com/v2/auth/authorize?client_key=${clientKey}&response_type=code&scope=${scope}&redirect_uri=${redirectUri}&state=${state}`;
  res.redirect(authUrl);
});

router.get('/tiktok/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const stateData = global.oauthStates?.[state];
  const frontendUrl = getFrontendUrl(stateData);

  if (error) return res.redirect(`${frontendUrl}/accounts?oauth_error=${encodeURIComponent(error)}`);

  if (!stateData) {
    return res.redirect(`${frontendUrl}/accounts?oauth_error=invalid_state`);
  }
  delete global.oauthStates[state];

  try {
    const clientKey = getSetting('tiktok_client_key');
    const clientSecret = getSetting('tiktok_client_secret');
    const baseUrl = getBaseUrl(req);
    const redirectUri = `${baseUrl}/api/oauth/tiktok/callback`;

    const body = `code=${code}&client_key=${clientKey}&client_secret=${clientSecret}&grant_type=authorization_code&redirect_uri=${encodeURIComponent(redirectUri)}`;
    const tokenData = await httpsRequest('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, body);

    if (!tokenData.access_token) {
      throw new Error(tokenData.error_description || 'Failed to get TikTok access token');
    }

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

const express = require('express');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

const INSTAGRAM_GRAPH_VERSION = 'v25.0';
const TIKTOK_API_VERSION = 'v2';

const ENV_MAP = {
  meta_app_id:          'META_APP_ID',
  meta_app_secret:      'META_APP_SECRET',
  meta_login_config_id: 'META_LOGIN_CONFIG_ID',
  tiktok_client_key:    'TIKTOK_CLIENT_KEY',
  tiktok_client_secret: 'TIKTOK_CLIENT_SECRET',
  anthropic_api_key:    'ANTHROPIC_API_KEY',
};

const INSTAGRAM_OAUTH_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments'
].join(',');

function getSetting(key) {
  const envKey = ENV_MAP[key];
  if (envKey && process.env[envKey]) {
    return process.env[envKey];
  }
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return (row && row.value) ? row.value : null;
}

function getBaseUrl(req) {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  return `${req.protocol}://${req.get('host')}`;
}

function getRedirectUri(req) {
  return `${getBaseUrl(req)}/api/oauth/instagram/callback`;
}

function getFrontendUrl(stateData) {
  if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL;
  if (stateData?.frontendOrigin) return stateData.frontendOrigin;
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
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function encodeForm(params) {
  return new URLSearchParams(params).toString();
}

function unwrapMetaData(payload) {
  if (Array.isArray(payload?.data)) return payload.data[0] || null;
  if (payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) return payload.data;
  return payload;
}

function buildInstagramAuthUrl(appId, redirectUri, state) {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: INSTAGRAM_OAUTH_SCOPES,
    state,
    enable_fb_login: 'false',
  });

  return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
}

router.get('/instagram/debug-auth-url', (req, res) => {
  const appId = getSetting('meta_app_id');
  const redirectUri = getRedirectUri(req);
  const legacyConfigId = getSetting('meta_login_config_id');

  if (!appId) {
    return res.json({
      error: 'Meta App ID not configured',
      meta_app_id: null,
    });
  }

  const state = 'DEBUG_STATE';
  const authUrl = buildInstagramAuthUrl(appId, redirectUri, state);

  res.json({
    source_file: 'backend/src/routes/oauth.js',
    instagram_graph_version: INSTAGRAM_GRAPH_VERSION,
    meta_app_id: appId,
    legacy_meta_login_config_id: legacyConfigId || null,
    flow_type: 'instagram_login',
    redirect_uri: redirectUri,
    scope_raw: INSTAGRAM_OAUTH_SCOPES,
    scope_list: INSTAGRAM_OAUTH_SCOPES.split(','),
    final_auth_url: authUrl,
    callback_route: '/api/oauth/instagram/callback',
    base_url_source: process.env.RAILWAY_PUBLIC_DOMAIN ? 'RAILWAY_PUBLIC_DOMAIN env' : 'req.protocol + req.host',
    railway_public_domain: process.env.RAILWAY_PUBLIC_DOMAIN || '(not set)',
    runtime_timestamp: new Date().toISOString(),
    meta_dashboard_checklist: {
      '1_instagram_product': 'Add the Instagram product to your Meta app',
      '2_business_login_settings': 'Open App Dashboard -> Instagram -> API setup with Instagram login -> Set up Instagram business login',
      '3_valid_oauth_redirect_uris': redirectUri,
      '4_scopes': INSTAGRAM_OAUTH_SCOPES,
      '5_enable_fb_login': 'SocialMind sends enable_fb_login=false to keep the flow on Instagram Login',
      '6_legacy_config_id': 'META_LOGIN_CONFIG_ID is ignored for Instagram Login and can be left empty'
    }
  });
});

router.get('/instagram/connect', (req, res) => {
  const appId = getSetting('meta_app_id');
  if (!appId) {
    return res.status(400).json({ error: 'Meta App ID not configured. Go to Settings first.' });
  }

  const redirectUri = getRedirectUri(req);
  const state = uuidv4();
  const referer = req.get('referer');
  const frontendOrigin = referer ? new URL(referer).origin : null;

  if (!global.oauthStates) global.oauthStates = {};
  global.oauthStates[state] = { createdAt: Date.now(), frontendOrigin };

  const authUrl = buildInstagramAuthUrl(appId, redirectUri, state);

  console.log('========== OAUTH CONNECT ==========');
  console.log('[OAuth] Flow:', 'Instagram Login');
  console.log('[OAuth] Meta App ID:', appId);
  console.log('[OAuth] Redirect URI:', redirectUri);
  console.log('[OAuth] Frontend origin:', frontendOrigin || '(no referer)');
  console.log('[OAuth] Scopes:', INSTAGRAM_OAUTH_SCOPES);
  console.log('[OAuth] Auth URL:', authUrl);
  console.log('====================================');

  res.redirect(authUrl);
});

router.get('/instagram/callback', async (req, res) => {
  const { code, state, error, error_reason, error_description } = req.query;

  const stateData = global.oauthStates?.[state];
  const frontendUrl = getFrontendUrl(stateData);

  console.log('[OAuth][CALLBACK] code:', code ? `${code.substring(0, 20)}...` : 'MISSING');
  console.log('[OAuth][CALLBACK] state:', state);
  console.log('[OAuth][CALLBACK] error:', error || 'none');
  console.log('[OAuth][CALLBACK] frontendUrl:', frontendUrl);

  if (error) {
    const oauthError = error_description || error_reason || error;
    console.log('[OAuth][CALLBACK] FAILED:', oauthError);
    return res.redirect(`${frontendUrl}/accounts?oauth_error=${encodeURIComponent(oauthError)}`);
  }

  if (!stateData) {
    console.log('[OAuth][CALLBACK] FAILED: invalid state token');
    return res.redirect(`${frontendUrl}/accounts?oauth_error=invalid_state`);
  }
  delete global.oauthStates[state];

  try {
    const appId = getSetting('meta_app_id');
    const appSecret = getSetting('meta_app_secret');
    const redirectUri = getRedirectUri(req);

    if (!appId || !appSecret) {
      throw new Error('Meta App ID or App Secret is missing');
    }

    console.log('[OAuth][TOKEN] App ID:', appId);
    console.log('[OAuth][TOKEN] App Secret:', `${appSecret.substring(0, 6)}...`);
    console.log('[OAuth][TOKEN] Redirect URI:', redirectUri);

    const shortTokenPayload = encodeForm({
      client_id: appId,
      client_secret: appSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    });

    const shortTokenResponse = await httpsRequest('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, shortTokenPayload);
    const shortTokenData = unwrapMetaData(shortTokenResponse);

    if (!shortTokenData?.access_token) {
      console.log('[OAuth][TOKEN] FAILED short-lived token:', JSON.stringify(shortTokenResponse));
      throw new Error(shortTokenResponse?.error?.message || 'Failed to get Instagram short-lived access token');
    }

    const shortToken = shortTokenData.access_token;
    const shortUserId = shortTokenData.user_id || null;
    console.log('[OAuth][TOKEN] Short-lived token:', `${shortToken.substring(0, 20)}...`);
    console.log('[OAuth][TOKEN] App-scoped user ID:', shortUserId || '(missing from token response)');

    const longTokenResponse = await httpsRequest(
      `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(appSecret)}&access_token=${encodeURIComponent(shortToken)}`
    );

    if (!longTokenResponse?.access_token) {
      console.log('[OAuth][TOKEN] FAILED long-lived token:', JSON.stringify(longTokenResponse));
      throw new Error(longTokenResponse?.error?.message || 'Failed to exchange Instagram long-lived access token');
    }

    const longToken = longTokenResponse.access_token;
    const expiresIn = Number(longTokenResponse.expires_in) || null;
    const tokenExpiry = expiresIn ? Math.floor(Date.now() / 1000) + expiresIn : null;

    console.log('[OAuth][TOKEN] Long-lived token:', `${longToken.substring(0, 20)}...`);
    console.log('[OAuth][TOKEN] Expires in (seconds):', expiresIn || '(unknown)');

    const profileResponse = await httpsRequest(
      `https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/me?fields=user_id,username&access_token=${encodeURIComponent(longToken)}`
    );
    const profile = unwrapMetaData(profileResponse);

    const igUserId = profile?.user_id || shortUserId;
    const username = profile?.username || (igUserId ? `ig_${igUserId}` : null);

    if (!igUserId || !username) {
      console.log('[OAuth][PROFILE] FAILED:', JSON.stringify(profileResponse));
      throw new Error('Instagram Login succeeded, but SocialMind could not read the Instagram account profile');
    }

    console.log(`[OAuth][PROFILE] @${username} (${igUserId})`);

    const subscribeResponse = await httpsRequest(
      `https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${igUserId}/subscribed_apps?subscribed_fields=comments,messages&access_token=${encodeURIComponent(longToken)}`,
      { method: 'POST' }
    );

    if (!subscribeResponse?.success) {
      console.log('[OAuth][WEBHOOKS] FAILED:', JSON.stringify(subscribeResponse));
      throw new Error(subscribeResponse?.error?.message || 'Instagram account connected, but webhook subscription failed');
    }

    console.log('[OAuth][WEBHOOKS] Subscribed to comments,messages');

    const id = uuidv4();
    db.prepare(`
      INSERT INTO accounts (id, platform, account_id, username, access_token, token_expiry, page_id, auth_type, is_active)
      VALUES (?, 'instagram', ?, ?, ?, ?, NULL, 'instagram_login', 1)
      ON CONFLICT(platform, account_id) DO UPDATE SET
        username = excluded.username,
        access_token = excluded.access_token,
        token_expiry = excluded.token_expiry,
        page_id = NULL,
        auth_type = 'instagram_login',
        is_active = 1,
        updated_at = unixepoch()
    `).run(id, igUserId, username, longToken, tokenExpiry);

    console.log(`[OAuth][SAVE] Connected @${username}`);
    res.redirect(`${frontendUrl}/accounts?oauth_success=1`);
  } catch (err) {
    console.error('[OAuth] FAILED:', err.message);
    res.redirect(`${frontendUrl}/accounts?oauth_error=${encodeURIComponent(err.message)}`);
  }
});

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

  const authUrl = `https://www.tiktok.com/${TIKTOK_API_VERSION}/auth/authorize?client_key=${clientKey}&response_type=code&scope=${scope}&redirect_uri=${redirectUri}&state=${state}`;
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

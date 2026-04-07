const express = require('express');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
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
  const scope = encodeURIComponent('instagram_basic,instagram_manage_comments,instagram_manage_messages,pages_show_list,pages_read_engagement,pages_manage_metadata');
  const state = uuidv4();

  // Store state temporarily (simple in-memory for now)
  if (!global.oauthStates) global.oauthStates = {};
  global.oauthStates[state] = { createdAt: Date.now() };

  const authUrl = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${appId}&redirect_uri=${redirectUri}&scope=${scope}&state=${state}&response_type=code`;

  res.redirect(authUrl);
});

// Step 2: Handle callback from Facebook
router.get('/instagram/callback', async (req, res) => {
  const { code, state, error } = req.query;

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

  if (error) {
    return res.redirect(`${frontendUrl}/accounts?oauth_error=${encodeURIComponent(error)}`);
  }

  // Validate state
  if (!global.oauthStates || !global.oauthStates[state]) {
    return res.redirect(`${frontendUrl}/accounts?oauth_error=invalid_state`);
  }
  delete global.oauthStates[state];

  try {
    const appId = getSetting('meta_app_id');
    const appSecret = getSetting('meta_app_secret');

    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : `${req.protocol}://${req.get('host')}`;

    const redirectUri = `${baseUrl}/api/oauth/instagram/callback`;

    // Exchange code for access token
    const tokenUrl = `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${code}`;
    const tokenData = await httpsRequest(tokenUrl);

    if (!tokenData.access_token) {
      throw new Error(tokenData.error?.message || 'Failed to get access token');
    }

    const shortToken = tokenData.access_token;

    // Exchange for long-lived token
    const longTokenUrl = `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortToken}`;
    const longTokenData = await httpsRequest(longTokenUrl);
    const longToken = longTokenData.access_token || shortToken;

    // Get user's Facebook Pages
    const pagesData = await httpsRequest(`https://graph.facebook.com/v19.0/me/accounts?access_token=${longToken}&fields=id,name,instagram_business_account`);

    if (!pagesData.data || pagesData.data.length === 0) {
      throw new Error('No Facebook Pages found. Make sure your Instagram is connected to a Facebook Page.');
    }

    let connectedCount = 0;

    for (const page of pagesData.data) {
      if (!page.instagram_business_account) continue;

      const igId = page.instagram_business_account.id;

      // Get page-specific token
      const pageTokenData = await httpsRequest(`https://graph.facebook.com/v19.0/${page.id}?fields=access_token&access_token=${longToken}`);
      const pageToken = pageTokenData.access_token || longToken;

      // Get Instagram username
      const igData = await httpsRequest(`https://graph.facebook.com/v19.0/${igId}?fields=username,name&access_token=${pageToken}`);
      const username = igData.username || igData.name || `ig_${igId}`;

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
      } catch (e) {
        console.error('Error saving account:', e.message);
      }
    }

    if (connectedCount === 0) {
      throw new Error('No Instagram Business accounts found. Make sure your Instagram is set to Business/Creator mode and linked to a Facebook Page.');
    }

    res.redirect(`${frontendUrl}/accounts?oauth_success=${connectedCount}`);
  } catch (err) {
    console.error('[OAuth] Instagram error:', err.message);
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

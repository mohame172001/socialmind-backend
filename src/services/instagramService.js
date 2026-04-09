const https = require('https');

const API_CONFIG = {
  facebook_login: {
    baseUrl: 'https://graph.facebook.com',
    version: 'v22.0',
    defaultTokenMode: 'query',
  },
  instagram_login: {
    baseUrl: 'https://graph.instagram.com',
    version: 'v25.0',
    defaultTokenMode: 'bearer',
  },
};

function getApiConfig(account) {
  const authType = account?.auth_type === 'instagram_login' ? 'instagram_login' : 'facebook_login';
  return API_CONFIG[authType];
}

function apiRequest(method, path, { account, params = {}, body = null, tokenMode = 'auto' } = {}) {
  return new Promise((resolve, reject) => {
    if (!account?.access_token) {
      reject(new Error('Instagram access token is missing'));
      return;
    }

    const config = getApiConfig(account);
    const mode = tokenMode === 'auto' ? config.defaultTokenMode : tokenMode;
    const url = new URL(`${config.baseUrl}/${config.version}${path}`);

    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, value);
      }
    });

    const headers = { 'Content-Type': 'application/json' };
    if (mode === 'bearer') {
      headers.Authorization = `Bearer ${account.access_token}`;
    } else {
      url.searchParams.set('access_token', account.access_token);
    }

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getMedia(account) {
  const response = await apiRequest('GET', `/${account.account_id}/media`, {
    account,
    params: {
      fields: 'id,caption,media_type,media_url,thumbnail_url,timestamp,permalink',
      limit: '25',
    },
    tokenMode: 'query',
  });

  return response.data || [];
}

async function subscribeApp(account, fields = ['comments', 'messages']) {
  return apiRequest('POST', `/${account.account_id}/subscribed_apps`, {
    account,
    params: {
      subscribed_fields: Array.isArray(fields) ? fields.join(',') : fields,
    },
    tokenMode: 'query',
  });
}

async function replyToComment(commentId, message, account) {
  console.log(`[IG Service] Replying to comment ${commentId} via ${account.auth_type || 'facebook_login'}`);
  console.log(`[IG Service] Message: "${message}"`);
  console.log(`[IG Service] Account: @${account.username || account.account_id}`);

  const result = await apiRequest('POST', `/${commentId}/replies`, {
    account,
    body: { message },
  });

  console.log('[IG Service] Reply sent:', JSON.stringify(result));
  return result;
}

async function sendDM({ commenterId, commentId, message, account }) {
  const senderId = account.page_id || account.account_id;
  const recipient = account.auth_type === 'instagram_login'
    ? { comment_id: commentId }
    : { id: commenterId };

  console.log(`[IG Service] Sending DM from ${senderId} via ${account.auth_type || 'facebook_login'}`);
  console.log(`[IG Service] Message: "${message}"`);

  const result = await apiRequest('POST', `/${senderId}/messages`, {
    account,
    body: {
      recipient,
      message: { text: message }
    },
  });

  console.log('[IG Service] DM sent:', JSON.stringify(result));
  return result;
}

async function verifyWebhook(token, expectedToken) {
  return token === expectedToken;
}

module.exports = { getMedia, subscribeApp, replyToComment, sendDM, verifyWebhook };

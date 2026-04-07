const https = require('https');

const BASE_URL = 'https://graph.facebook.com/v19.0';

function apiRequest(method, path, params = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function replyToComment(commentId, message, accessToken) {
  return apiRequest('POST', `/${commentId}/replies`, { access_token: accessToken }, { message });
}

async function sendDM(recipientId, message, pageId, accessToken) {
  return apiRequest('POST', `/${pageId}/messages`, { access_token: accessToken }, {
    recipient: { id: recipientId },
    message: { text: message }
  });
}

async function verifyWebhook(token, expectedToken) {
  return token === expectedToken;
}

module.exports = { replyToComment, sendDM, verifyWebhook };

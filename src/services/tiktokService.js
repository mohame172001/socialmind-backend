const https = require('https');

const BASE_URL = 'https://open.tiktokapis.com/v2';

function apiRequest(method, path, accessToken, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}${path}`);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error && parsed.error.code !== 'ok') {
            reject(new Error(parsed.error.message || 'TikTok API error'));
          } else {
            resolve(parsed);
          }
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

async function replyToComment(videoId, commentId, text, accessToken) {
  return apiRequest('POST', '/comment/reply/create/', accessToken, {
    video_id: videoId,
    parent_comment_id: commentId,
    text
  });
}

async function sendDM(recipientOpenId, message, accessToken) {
  // TikTok DM via messaging API
  return apiRequest('POST', '/direct_message/send/', accessToken, {
    recipient_open_id: recipientOpenId,
    message_type: 'text',
    content: { text: message }
  });
}

module.exports = { replyToComment, sendDM };

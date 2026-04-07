const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

async function generateReply(commentText, commenterUsername, context = {}) {
  const apiKey = getSetting('anthropic_api_key');
  if (!apiKey) {
    throw new Error('Anthropic API key not configured');
  }

  const client = new Anthropic({ apiKey });
  let promptTemplate = getSetting('ai_prompt_template') ||
    'You are a friendly social media assistant. Reply to this comment in a helpful, engaging way. Keep it under 150 characters. Comment: {{comment}}';

  const prompt = promptTemplate
    .replace('{{comment}}', commentText)
    .replace('{{username}}', commenterUsername || 'user')
    .replace('{{platform}}', context.platform || 'social media');

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }]
  });

  return message.content[0].text.trim();
}

module.exports = { generateReply };

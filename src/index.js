require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy — required for Railway/Render/Heroku (reverse proxy sets X-Forwarded-For)
// Without this, express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));

// Rate limiting — only on /api/ routes, NOT on /webhooks/ (Meta needs unrestricted access)
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500 });
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'SocialMind', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/rules', require('./routes/rules'));
app.use('/api/activity', require('./routes/activity'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/oauth', require('./routes/oauth'));
app.use('/api/agent', require('./routes/agent'));

// Webhook routes
app.use('/webhooks/instagram', require('./webhooks/instagram'));
app.use('/webhooks/tiktok', require('./webhooks/tiktok'));

// Webhook info endpoint
app.get('/webhooks', (req, res) => {
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `${req.protocol}://${req.get('host')}`;

  res.json({
    instagram_webhook_url: `${baseUrl}/webhooks/instagram`,
    tiktok_webhook_url: `${baseUrl}/webhooks/tiktok`,
    instagram_verify_token: process.env.INSTAGRAM_VERIFY_TOKEN || 'socialmind_verify_2024',
    tiktok_verify_token: process.env.TIKTOK_VERIFY_TOKEN || 'socialmind_tiktok_2024'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  const db = require('./db');
  const getVal = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r?.value || ''; };

  console.log(`\n🚀 SocialMind Backend running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 Webhook info: http://localhost:${PORT}/webhooks`);
  console.log(`\n─── Config Status ───`);
  console.log(`  META_APP_ID:       ${getVal('meta_app_id') ? '✅ SET' : '❌ MISSING'} (env: ${process.env.META_APP_ID ? 'YES' : 'no'})`);
  console.log(`  META_APP_SECRET:   ${getVal('meta_app_secret') ? '✅ SET' : '❌ MISSING'} (env: ${process.env.META_APP_SECRET ? 'YES' : 'no'})`);
  console.log(`  ANTHROPIC_API_KEY: ${getVal('anthropic_api_key') ? '✅ SET' : '❌ MISSING'} (env: ${process.env.ANTHROPIC_API_KEY ? 'YES' : 'no'})`);
  console.log(`  FRONTEND_URL:      ${process.env.FRONTEND_URL || '(default: http://localhost:5173)'}`);
  console.log(`  RAILWAY_DOMAIN:    ${process.env.RAILWAY_PUBLIC_DOMAIN || '(local mode)'}`);
  console.log(`─────────────────────\n`);
});

module.exports = app;

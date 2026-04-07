const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

// GET /api/agent/status - quick status for voice agent
router.get('/status', (req, res) => {
  const accounts = db.prepare('SELECT platform, username, is_active FROM accounts').all();
  const rules = db.prepare('SELECT name, is_active FROM rules').all();
  const stats = db.prepare(`
    SELECT
      COUNT(CASE WHEN status='sent'    AND created_at > (unixepoch() - 86400) THEN 1 END) AS sent_today,
      COUNT(CASE WHEN status='failed'  AND created_at > (unixepoch() - 86400) THEN 1 END) AS failed_today,
      COUNT(CASE WHEN status='pending'                                         THEN 1 END) AS pending
    FROM activity_log
  `).get();

  res.json({ accounts, rules, stats });
});

// POST /api/agent/chat - natural language command (Arabic)
router.post('/chat', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'Command required' });

  const apiKey = getSetting('anthropic_api_key');
  if (!apiKey) {
    return res.json({
      response: 'لم يتم ضبط مفتاح الذكاء الاصطناعي بعد. يرجى الذهاب إلى الإعدادات وإضافة مفتاح Anthropic.'
    });
  }

  // Fetch current state
  const accounts = db.prepare('SELECT platform, username, is_active FROM accounts').all();
  const rules = db.prepare(`
    SELECT r.name, r.trigger_type, r.action_type, r.is_active, a.username, a.platform
    FROM rules r JOIN accounts a ON r.account_id = a.id
  `).all();
  const stats = db.prepare(`
    SELECT
      COUNT(CASE WHEN status='sent'    AND created_at > (unixepoch() - 86400) THEN 1 END) AS sent_today,
      COUNT(CASE WHEN status='failed'  AND created_at > (unixepoch() - 86400) THEN 1 END) AS failed_today,
      COUNT(CASE WHEN status='pending'                                         THEN 1 END) AS pending,
      COUNT(*)                                                                              AS total
    FROM activity_log
  `).get();

  const recentActivity = db.prepare(`
    SELECT platform, commenter_username, comment_text, action_taken, status, created_at
    FROM activity_log ORDER BY created_at DESC LIMIT 5
  `).all();

  const accountsText = accounts.length
    ? accounts.map(a => `@${a.username} (${a.platform === 'instagram' ? 'انستجرام' : 'تيك توك'}، ${a.is_active ? 'نشط' : 'موقف'})`).join('، ')
    : 'لا يوجد حسابات مضافة';

  const rulesText = rules.length
    ? rules.map(r => `"${r.name}" لـ @${r.username} (${r.is_active ? 'نشطة' : 'موقفة'})`).join('، ')
    : 'لا يوجد قواعد';

  const recentText = recentActivity.length
    ? recentActivity.map(a => `• @${a.commenter_username || '?'} على ${a.platform === 'instagram' ? 'IG' : 'TK'} [${a.status}]: "${(a.comment_text || '').slice(0, 40)}"`).join('\n')
    : 'لا يوجد نشاط حديث';

  const systemPrompt = `أنت "ميندي"، المساعد الصوتي الذكي لتطبيق SocialMind.
تتكلم عربي مصري بطريقة طبيعية ودودة ومتفاعلة - زي صديق بيساعد مش روبوت.
صاحبك اسمه "سيدي".

━━ حالة التطبيق دلوقتي ━━
الحسابات المضافة: ${accountsText}
القواعد النشطة: ${rulesText}
إحصائيات اليوم: أُرسل ${stats?.sent_today || 0} رد | فشل ${stats?.failed_today || 0} | في الانتظار ${stats?.pending || 0}
الإجمالي الكلي: ${stats?.total || 0} إجراء
آخر النشاطات:
${recentText}
━━━━━━━━━━━━━━━━━━━━

تعليمات التفاعل:
- رد بشكل طبيعي ومتفاعل حسب السؤال - مش لازم تكون قصير دايماً
- لو سألك عن إحصائيات أو أرقام → ابعتها مباشرة من البيانات فوق
- لو سألك "إيه آخر نشاط" أو "حصل إيه" → اشرح من آخر النشاطات
- لو طلب يضيف حساب → قوله "روح على Accounts وادوس Add Account"
- لو طلب قاعدة جديدة → قوله "روح على Rules وادوس New Rule"
- لو سألك عن حاجة عامة (أخبار، طقس، إلخ) → رد بطريقة ودودة وقوله إنك متخصص في SocialMind
- لو قالك "كيفك" أو سلّم عليك → رد بطريقة ودودة وطبيعية
- استخدم الأرقام الحقيقية من البيانات دايماً
- لو مفيش بيانات (حسابات أو قواعد) → قله يضيف حساب الأول عشان تبدأ`;

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: command }]
    });

    res.json({ response: message.content[0].text.trim() });
  } catch (err) {
    console.error('Agent chat error:', err.message);
    res.status(500).json({ response: 'حصل خطأ في الاتصال بالذكاء الاصطناعي. جرب تاني.' });
  }
});

module.exports = router;

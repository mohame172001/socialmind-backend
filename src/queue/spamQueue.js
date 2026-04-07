const { v4: uuidv4 } = require('uuid');
const db = require('../db');

class SpamQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.intervalId = null;
    this.start();
  }

  start() {
    // Process queue every 5 seconds
    this.intervalId = setInterval(() => this.processNext(), 5000);
    console.log('[Queue] Anti-spam queue started');
  }

  getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  getHourBucket() {
    return Math.floor(Date.now() / 3600000);
  }

  canSendToAccount(accountId) {
    const maxPerHour = parseInt(this.getSetting('max_replies_per_hour') || '30');
    const bucket = this.getHourBucket();
    const row = db.prepare('SELECT reply_count FROM hourly_stats WHERE account_id = ? AND hour_bucket = ?').get(accountId, bucket);
    const count = row ? row.reply_count : 0;
    return count < maxPerHour;
  }

  canSendToUser(accountId, targetUserId) {
    const cooldownMinutes = parseInt(this.getSetting('user_cooldown_minutes') || '60');
    const cutoff = Math.floor(Date.now() / 1000) - (cooldownMinutes * 60);
    const row = db.prepare('SELECT last_action_at FROM spam_tracker WHERE account_id = ? AND target_user_id = ?').get(accountId, targetUserId);
    if (!row) return true;
    return row.last_action_at < cutoff;
  }

  recordSent(accountId, targetUserId) {
    const now = Math.floor(Date.now() / 1000);
    const bucket = this.getHourBucket();

    // Update spam tracker
    db.prepare(`
      INSERT INTO spam_tracker (id, account_id, target_user_id, last_action_at, action_count_hour)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(account_id, target_user_id) DO UPDATE SET
        last_action_at = excluded.last_action_at,
        action_count_hour = action_count_hour + 1
    `).run(uuidv4(), accountId, targetUserId, now);

    // Update hourly stats
    db.prepare(`
      INSERT INTO hourly_stats (id, account_id, hour_bucket, reply_count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(account_id, hour_bucket) DO UPDATE SET
        reply_count = reply_count + 1
    `).run(uuidv4(), accountId, bucket);
  }

  enqueue(job) {
    const minDelay = parseInt(this.getSetting('min_delay_seconds') || '45');
    const maxDelay = parseInt(this.getSetting('max_delay_seconds') || '120');
    const delayMs = (Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay) * 1000;
    const scheduledAt = Date.now() + delayMs;

    const item = {
      id: uuidv4(),
      ...job,
      scheduledAt,
      attempts: 0
    };

    this.queue.push(item);

    // Log to DB as pending
    if (job.logId) {
      db.prepare('UPDATE activity_log SET status = ?, scheduled_at = ? WHERE id = ?')
        .run('pending', Math.floor(scheduledAt / 1000), job.logId);
    }

    console.log(`[Queue] Enqueued job ${item.id}, scheduled in ${Math.round(delayMs/1000)}s`);
    return item.id;
  }

  async processNext() {
    if (this.processing || this.queue.length === 0) return;

    const now = Date.now();
    const readyIndex = this.queue.findIndex(item => item.scheduledAt <= now);
    if (readyIndex === -1) return;

    const job = this.queue.splice(readyIndex, 1)[0];
    this.processing = true;

    try {
      // Check spam limits
      if (!this.canSendToAccount(job.accountId)) {
        console.log(`[Queue] Account ${job.accountId} hit hourly limit, requeuing`);
        job.scheduledAt = Date.now() + 300000; // retry in 5 min
        this.queue.push(job);
        this.processing = false;
        return;
      }

      if (job.targetUserId && !this.canSendToUser(job.accountId, job.targetUserId)) {
        console.log(`[Queue] User ${job.targetUserId} in cooldown, skipping`);
        if (job.logId) {
          db.prepare('UPDATE activity_log SET status = ?, executed_at = ? WHERE id = ?')
            .run('skipped', Math.floor(Date.now() / 1000), job.logId);
        }
        this.processing = false;
        return;
      }

      // Execute the job
      await job.execute();

      // Record successful send
      if (job.targetUserId) {
        this.recordSent(job.accountId, job.targetUserId);
      }

      if (job.logId) {
        db.prepare('UPDATE activity_log SET status = ?, executed_at = ? WHERE id = ?')
          .run('sent', Math.floor(Date.now() / 1000), job.logId);
      }

      console.log(`[Queue] Job ${job.id} executed successfully`);
    } catch (err) {
      console.error(`[Queue] Job ${job.id} failed:`, err.message);
      if (job.logId) {
        db.prepare('UPDATE activity_log SET status = ?, error_message = ?, executed_at = ? WHERE id = ?')
          .run('failed', err.message, Math.floor(Date.now() / 1000), job.logId);
      }
    }

    this.processing = false;
  }

  getStats() {
    return {
      queueLength: this.queue.length,
      pendingJobs: this.queue.map(j => ({
        id: j.id,
        accountId: j.accountId,
        scheduledAt: j.scheduledAt,
        timeUntil: Math.max(0, Math.round((j.scheduledAt - Date.now()) / 1000))
      }))
    };
  }
}

module.exports = new SpamQueue();

const { supabase } = require('./supabase');
const whatsappService = require('./whatsappService');
const logger = require('../utils/logger');

class NotificationWorker {
  constructor() {
    this.interval = null;
    this.POLL_INTERVAL = 15000; // 15 seconds
    this.isProcessing = false;
  }

  start() {
    logger.info('🚀 Notification Worker started...');
    this.interval = setInterval(() => this.processQueue(), this.POLL_INTERVAL);
    // Initial run
    this.processQueue();
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      logger.info('🛑 Notification Worker stopped.');
    }
  }

  async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // 1. Fetch and Lock jobs atomically using RPC
      const { data: jobs, error } = await supabase.rpc('fetch_next_notification_jobs', { p_limit: 10 });

      if (error) throw error;
      if (!jobs || jobs.length === 0) {
        this.isProcessing = false;
        return;
      }

      logger.info(`🔄 Processing ${jobs.length} locked notification jobs...`);

      for (const job of jobs) {
        await this.handleJob(job);
      }

    } catch (err) {
      logger.error('Error in Notification Worker loop:', err.message);
    } finally {
      this.isProcessing = false;
    }
  }

  async handleJob(job) {
    try {
      // Skip if WhatsApp is not ready
      if (!whatsappService.isReady) {
        // Revert status to failed but don't increment retry yet, just wait for service
        await supabase.from('notification_queue').update({ status: 'failed', last_error: 'WhatsApp service not ready' }).eq('id', job.id);
        return;
      }

      const { recipient, payload, type } = job;

      if (type === 'whatsapp') {
        await whatsappService.sendMessage(recipient, payload.message);
      }

      // 2. Mark as sent
      await supabase
        .from('notification_queue')
        .update({ 
          status: 'sent', 
          updated_at: new Date() 
        })
        .eq('id', job.id);

      logger.info(`✅ Job ${job.id} sent successfully`);

    } catch (err) {
      const nextRetry = new Date();
      // Exponential backoff: 2^retry_count * 5 minutes
      const minutes = Math.pow(2, (job.retry_count || 0)) * 5;
      nextRetry.setMinutes(nextRetry.getMinutes() + minutes);

      logger.error(`❌ Job ${job.id} failed. Retrying in ${minutes}m:`, err.message);

      await supabase
        .from('notification_queue')
        .update({
          status: 'failed',
          retry_count: (job.retry_count || 0) + 1,
          last_error: err.message,
          next_retry_at: nextRetry,
          updated_at: new Date()
        })
        .eq('id', job.id);
    }
  }
}

const instance = new NotificationWorker();
module.exports = instance;

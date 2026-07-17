const { supabase } = require('./supabase');
const whatsappService = require('./whatsappService');
const notificationWorker = require('./notificationWorker');
const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const HEALTH_SNAPSHOT_VERSION = 1;
const COLLECTOR_VERSION = '1.2.0';

let r2Telemetry = {
  lastDeleteTime: null,
  lastUploadTime: null,
  averageUploadTimeMs: 0,
  uploadCount: 0,
  totalUploadTimeMs: 0
};

function recordR2Upload(durationMs) {
  r2Telemetry.uploadCount++;
  r2Telemetry.totalUploadTimeMs += durationMs;
  r2Telemetry.averageUploadTimeMs = Math.round(r2Telemetry.totalUploadTimeMs / r2Telemetry.uploadCount);
  r2Telemetry.lastUploadTime = new Date().toISOString();
}

function recordR2Delete() {
  r2Telemetry.lastDeleteTime = new Date().toISOString();
}

// Enum representing the status of the collector task itself
const CollectorStatus = Object.freeze({
  IDLE: 'idle',
  COLLECTING: 'collecting',
  HEALTHY: 'healthy',
  FAILED: 'failed'
});

// Pluggable cache driver interface
class MemoryCacheDriver {
  constructor() {
    this.cache = {};
  }
  async get(key) {
    return this.cache[key] || null;
  }
  async set(key, value) {
    this.cache[key] = value;
  }
}

const cacheDriver = new MemoryCacheDriver();

let smtpTransporterInstance = null;
let lastCronRunTime = null;
let collectorStats = {
  last_success_time: null,
  consecutive_failures: 0,
  collector_status: CollectorStatus.IDLE
};

function getSMTPTransporter() {
  if (!smtpTransporterInstance && process.env.SMTP_HOST) {
    smtpTransporterInstance = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      },
      timeout: 3000
    });
  }
  return smtpTransporterInstance;
}

function registerCronRun() {
  lastCronRunTime = new Date().toISOString();
}

async function collectHealth() {
  const collectionStart = Date.now();
  collectorStats.collector_status = CollectorStatus.COLLECTING;
  
  try {
    const snapshot = {
      snapshot_version: HEALTH_SNAPSHOT_VERSION,
      collector_version: COLLECTOR_VERSION,
      timestamp: new Date().toISOString(),
      schema_version: 'unknown',
      cloudflare: 'unknown',
      supabase: 'unknown',
      supabase_latency: '0ms',
      render: 'healthy',
      node_version: process.version,
      environment: process.env.NODE_ENV || 'development',
      render_stats: {
        heapTotal: process.memoryUsage().heapTotal,
        heapUsed: process.memoryUsage().heapUsed,
        external: process.memoryUsage().external,
        rss: process.memoryUsage().rss,
        uptime: Math.floor(process.uptime())
      },
      r2: 'unknown',
      r2_stats: null,
      workers: 'unknown',
      queues: 'unknown',
      queue_stats: { pending: 0, failed: 0 },
      turnstile: 'unknown',
      google_oauth: 'unknown',
      smtp: 'unknown',
      whatsapp: 'unknown',
      cron_jobs: 'unknown',
      last_collection_duration: '0ms',
      collector: {
        last_success_time: collectorStats.last_success_time,
        consecutive_failures: collectorStats.consecutive_failures,
        status: CollectorStatus.HEALTHY
      }
    };

    // 1. Supabase Check
    try {
      const start = Date.now();
      const { error } = await supabase.from('stores').select('count', { count: 'exact', head: true });
      const latency = Date.now() - start;
      snapshot.supabase_latency = `${latency}ms`;

      if (error) {
        snapshot.supabase = 'unhealthy';
      } else if (latency > 500) {
        snapshot.supabase = 'degraded';
      } else {
        snapshot.supabase = 'healthy';
      }
    } catch (err) {
      snapshot.supabase = 'unhealthy';
      logger.error('HealthCollector: Supabase check failed', err);
    }

    // Query Database Schema Version
    try {
      const { data, error } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'schema_version')
        .maybeSingle();
      if (!error && data) {
        snapshot.schema_version = data.value;
      }
    } catch {
      // Ignore settings query error, keep default
    }

    // 2. WhatsApp Status
    if (process.env.ENABLE_WHATSAPP === 'true') {
      try {
        const status = whatsappService.getStatus();
        snapshot.whatsapp = status === 'connected' ? 'healthy' : (status === 'connecting' ? 'warning' : 'unhealthy');
      } catch {
        snapshot.whatsapp = 'unhealthy';
      }
    } else {
      snapshot.whatsapp = 'not_configured';
    }

    // 3. SMTP check via Singleton Transporter
    if (process.env.SMTP_HOST && process.env.SMTP_USER) {
      try {
        const transporter = getSMTPTransporter();
        if (transporter) {
          await transporter.verify();
          snapshot.smtp = 'healthy';
        } else {
          snapshot.smtp = 'unhealthy';
        }
      } catch (err) {
        snapshot.smtp = 'unhealthy';
        logger.error('HealthCollector: SMTP check failed', err);
      }
    } else {
      snapshot.smtp = 'not_configured';
    }

    // 4. Cloudflare CDN Trace Ping
    try {
      const cfRes = await fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(3000) });
      snapshot.cloudflare = cfRes.ok ? 'healthy' : 'unhealthy';
    } catch (err) {
      snapshot.cloudflare = 'unhealthy';
      logger.error('HealthCollector: Cloudflare trace check failed', err);
    }

    // 5. Cloudflare Turnstile API Reachability check
    if (process.env.TURNSTILE_SECRET_KEY) {
      try {
        const tsRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret: 'test_health_secret', response: 'test_health_response' }),
          signal: AbortSignal.timeout(3000)
        });
        // Turnstile returns HTTP 200/400 status if reachable
        snapshot.turnstile = tsRes.ok || tsRes.status === 400 ? 'healthy' : 'unhealthy';
      } catch (err) {
        snapshot.turnstile = 'unhealthy';
        logger.error('HealthCollector: Turnstile siteverify check failed', err);
      }
    } else {
      snapshot.turnstile = 'unknown';
    }

    // 6. Google OAuth endpoint configuration check
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
      try {
        const googleRes = await fetch('https://accounts.google.com/.well-known/openid-configuration', {
          signal: AbortSignal.timeout(3000)
        });
        snapshot.google_oauth = googleRes.ok ? 'healthy' : 'unhealthy';
      } catch (err) {
        snapshot.google_oauth = 'unhealthy';
        logger.error('HealthCollector: Google openid configuration trace failed', err);
      }
    } else {
      snapshot.google_oauth = 'unknown';
    }

    // 7. Cloudflare R2 Connection & Telemetry check
    if (process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET_NAME) {
      try {
        const r2Client = new S3Client({
          region: 'auto',
          endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
          credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
          },
        });

        let totalSize = 0;
        let count = 0;
        let maxLastModified = null;
        let continuationToken = undefined;

        do {
          const listCmd = new ListObjectsV2Command({
            Bucket: process.env.R2_BUCKET_NAME,
            ContinuationToken: continuationToken,
            MaxKeys: 1000
          });
          const res = await r2Client.send(listCmd);
          if (res.Contents) {
            for (const obj of res.Contents) {
              totalSize += obj.Size;
              count++;
              if (!maxLastModified || obj.LastModified > maxLastModified) {
                maxLastModified = obj.LastModified;
              }
            }
          }
          continuationToken = res.NextContinuationToken;
        } while (continuationToken);

        snapshot.r2 = 'healthy';
        snapshot.r2_stats = {
          bucketName: process.env.R2_BUCKET_NAME,
          storageUsedBytes: totalSize,
          objectCount: count,
          lastUpload: maxLastModified ? maxLastModified.toISOString() : r2Telemetry.lastUploadTime,
          lastDelete: r2Telemetry.lastDeleteTime,
          averageUploadTimeMs: r2Telemetry.averageUploadTimeMs
        };
      } catch (err) {
        snapshot.r2 = 'unhealthy';
        snapshot.r2_stats = {
          bucketName: process.env.R2_BUCKET_NAME || 'unknown',
          storageUsedBytes: 0,
          objectCount: 0,
          lastUpload: null,
          lastDelete: r2Telemetry.lastDeleteTime,
          averageUploadTimeMs: r2Telemetry.averageUploadTimeMs
        };
        logger.error('HealthCollector: R2 list objects check failed', err);
      }
    } else {
      snapshot.r2 = 'not_configured';
    }

    // 8. Cron Jobs Check (last executed time check)
    if (lastCronRunTime) {
      const elapsed = Date.now() - new Date(lastCronRunTime).getTime();
      snapshot.cron_jobs = elapsed < 30 * 60 * 1000 ? 'healthy' : 'warning'; // Warning if pruner hasn't run in 30 mins
    } else {
      snapshot.cron_jobs = 'warning';
    }

    // 9. Queues Status (Database notification queue)
    try {
      const { data: pending } = await supabase.from('notification_queue').select('id').eq('status', 'pending');
      const { data: failed } = await supabase.from('notification_queue').select('id').eq('status', 'failed');
      snapshot.queue_stats = {
        pending: pending?.length || 0,
        failed: failed?.length || 0
      };
      
      if (failed?.length > 50) {
        snapshot.queues = 'unhealthy';
      } else if (failed?.length > 10) {
        snapshot.queues = 'degraded';
      } else {
        snapshot.queues = 'healthy';
      }
    } catch {
      snapshot.queues = 'unhealthy';
    }

    // 10. Workers status (Notification background worker daemon)
    if (process.env.ENABLE_WHATSAPP === 'true') {
      const workerStats = notificationWorker.getStats();
      if (!workerStats.lastRunTime) {
        snapshot.workers = 'warning';
      } else {
        const elapsed = Date.now() - new Date(workerStats.lastRunTime).getTime();
        if (elapsed > 10 * 60 * 1000 || workerStats.consecutiveFailures > 5) {
          snapshot.workers = 'unhealthy';
        } else if (elapsed > 3 * 60 * 1000 || workerStats.consecutiveFailures > 0) {
          snapshot.workers = 'degraded';
        } else {
          snapshot.workers = 'healthy';
        }
      }
      snapshot.worker_stats = workerStats;
    } else {
      snapshot.workers = 'unknown';
    }

    snapshot.last_collection_duration = `${Date.now() - collectionStart}ms`;
    await cacheDriver.set('platform_health_snapshot', snapshot);
    collectorStats.last_success_time = new Date().toISOString();
    collectorStats.consecutive_failures = 0;
    collectorStats.collector_status = CollectorStatus.IDLE;
  } catch (err) {
    collectorStats.consecutive_failures++;
    collectorStats.collector_status = CollectorStatus.FAILED;
    logger.error('HealthCollector: Collection execution error', err);
  }
}

let healthInterval;
function startCollector() {
  collectHealth();
  healthInterval = setInterval(collectHealth, 60000); // 1 minute
  return healthInterval;
}

function stopCollector() {
  if (healthInterval) {
    clearInterval(healthInterval);
  }
}

async function getSnapshot() {
  const snapshot = await cacheDriver.get('platform_health_snapshot');
  if (!snapshot) {
    return {
      snapshot_version: HEALTH_SNAPSHOT_VERSION,
      collector: {
        status: CollectorStatus.FAILED,
        consecutive_failures: collectorStats.consecutive_failures,
        last_success_time: collectorStats.last_success_time
      }
    };
  }
  return snapshot;
}

module.exports = { startCollector, stopCollector, getSnapshot, registerCronRun, recordR2Upload, recordR2Delete };


const { supabase } = require('./supabase');
const whatsappService = require('./whatsappService');
const whatsappPoolService = require('./whatsappPoolService');
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
let r2Inventory = {
  status: 'pending',
  scannedAt: null,
  objectCount: null,
  storageUsedBytes: null,
  lastUpload: null,
  error: null
};
let r2InventoryPromise = null;
const R2_INVENTORY_REFRESH_MS = 10 * 60 * 1000;

function recordR2Upload(durationMs) {
  r2Telemetry.uploadCount++;
  r2Telemetry.totalUploadTimeMs += durationMs;
  r2Telemetry.averageUploadTimeMs = Math.round(r2Telemetry.totalUploadTimeMs / r2Telemetry.uploadCount);
  r2Telemetry.lastUploadTime = new Date().toISOString();
}

function recordR2Delete() {
  r2Telemetry.lastDeleteTime = new Date().toISOString();
}

async function refreshR2Inventory(client) {
  if (r2InventoryPromise) return r2InventoryPromise;
  r2InventoryPromise = (async () => {
    let token;
    let count = 0;
    let bytes = 0;
    let lastUpload = null;
    do {
      const page = await client.send(new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET_NAME,
        MaxKeys: 1000,
        ContinuationToken: token
      }));
      for (const object of page.Contents || []) {
        count += 1;
        bytes += Number(object.Size) || 0;
        if (object.LastModified && (!lastUpload || object.LastModified > lastUpload)) lastUpload = object.LastModified;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    r2Inventory = {
      status: 'ready',
      scannedAt: new Date().toISOString(),
      objectCount: count,
      storageUsedBytes: bytes,
      lastUpload: lastUpload?.toISOString?.() || r2Telemetry.lastUploadTime,
      error: null
    };
    return r2Inventory;
  })().catch((error) => {
    r2Inventory = { ...r2Inventory, status: 'error', error: error.message, scannedAt: r2Inventory.scannedAt };
    throw error;
  }).finally(() => { r2InventoryPromise = null; });
  return r2InventoryPromise;
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
let lastSmtpDiagnostic = { signature: null, at: 0 };
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
      cron_stats: null,
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
        const poolStatus = whatsappPoolService.getStatus();
        snapshot.whatsapp = poolStatus.status === 'connected' ? 'healthy' : 'unhealthy';
        snapshot.whatsapp_accounts = poolStatus.accounts;
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
        const code = err?.code || err?.responseCode || 'SMTP_CHECK_FAILED';
        const signature = `${code}:${err?.command || 'unknown'}`;
        snapshot.smtp = code === 'EAUTH' || code === '535' ? 'misconfigured' : 'unhealthy';
        snapshot.smtp_diagnostic = { code, command: err?.command || null };
        if (lastSmtpDiagnostic.signature !== signature || Date.now() - lastSmtpDiagnostic.at > 15 * 60 * 1000) {
          lastSmtpDiagnostic = { signature, at: Date.now() };
          logger.warn('HealthCollector: SMTP probe failed', { code, command: err?.command || null });
        }
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
          forcePathStyle: true,
          credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
          },
        });

        const probe = await r2Client.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_NAME, MaxKeys: 1 }));
        if (!r2Inventory.scannedAt || Date.now() - new Date(r2Inventory.scannedAt).getTime() > R2_INVENTORY_REFRESH_MS) {
          refreshR2Inventory(r2Client).catch((error) => logger.error('HealthCollector: R2 inventory refresh failed', error.message));
        }

        snapshot.r2 = 'healthy';
        snapshot.r2_stats = {
          bucketName: process.env.R2_BUCKET_NAME,
          storageUsedBytes: r2Inventory.storageUsedBytes,
          objectCount: r2Inventory.objectCount,
          lastUpload: r2Inventory.lastUpload || r2Telemetry.lastUploadTime,
          lastDelete: r2Telemetry.lastDeleteTime,
          averageUploadTimeMs: r2Telemetry.uploadCount ? r2Telemetry.averageUploadTimeMs : null,
          inventoryStatus: r2Inventory.status,
          inventoryScannedAt: r2Inventory.scannedAt,
          inventoryError: r2Inventory.error
        };
      } catch (err) {
        snapshot.r2 = 'unhealthy';
        snapshot.r2_stats = {
          bucketName: process.env.R2_BUCKET_NAME || 'unknown',
          storageUsedBytes: null,
          objectCount: null,
          lastUpload: null,
          lastDelete: r2Telemetry.lastDeleteTime,
          averageUploadTimeMs: r2Telemetry.uploadCount ? r2Telemetry.averageUploadTimeMs : null,
          inventoryStatus: 'error',
          inventoryError: err.message
        };
        logger.error('HealthCollector: R2 list objects check failed', err);
      }
    } else {
      snapshot.r2 = 'not_configured';
    }

    // 8. Cron Jobs Check (Reads persistent retention run from database)
    try {
      const { data: cronSetting } = await supabase
        .from('system_settings')
        .select('value, updated_at')
        .eq('key', 'last_retention_cron_run')
        .maybeSingle();

      if (cronSetting?.value) {
        const parsed = typeof cronSetting.value === 'string' ? JSON.parse(cronSetting.value) : cronSetting.value;
        const lastRunTime = parsed.timestamp || cronSetting.updated_at;
        const elapsed = Date.now() - new Date(lastRunTime).getTime();

        snapshot.cron_jobs = elapsed < 35 * 60 * 1000 ? 'healthy' : 'warning';
        snapshot.cron_stats = {
          lastRunAt: lastRunTime,
          durationMs: parsed.durationMs || 0,
          elapsedMinutes: Math.round(elapsed / (60 * 1000)),
          details: parsed
        };
      } else if (lastCronRunTime) {
        const elapsed = Date.now() - new Date(lastCronRunTime).getTime();
        snapshot.cron_jobs = elapsed < 35 * 60 * 1000 ? 'healthy' : 'warning';
        snapshot.cron_stats = {
          lastRunAt: lastCronRunTime,
          durationMs: 0,
          elapsedMinutes: Math.round(elapsed / (60 * 1000)),
          details: null
        };
      } else {
        snapshot.cron_jobs = 'idle';
        snapshot.cron_stats = null;
      }
    } catch (cronErr) {
      snapshot.cron_jobs = 'warning';
      snapshot.cron_stats = null;
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

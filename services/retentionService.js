'use strict';

const { supabase } = require('./supabase');
const { runProofRetentionCleanup } = require('./proofRetentionJob');
const { safeDeleteR2Objects, extractR2Key } = require('../utils/r2Helper');
const logger = require('../utils/logger');

/**
 * Auto-close resolved tickets after 14 days of customer/merchant inactivity,
 * and purge closed tickets older than 90 days along with their R2 attachments.
 */
async function cleanupResolvedSupportTickets() {
  const result = { autoClosed: 0, purgedTickets: 0, deletedAttachments: 0 };
  const now = new Date();

  // 1. Auto-close resolved tickets inactive for 14+ days
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const { data: autoCloseData, error: autoCloseErr } = await supabase
      .from('store_support_tickets')
      .update({ status: 'closed', updated_at: now.toISOString() })
      .eq('status', 'resolved')
      .lt('updated_at', fourteenDaysAgo)
      .select('id');

    if (autoCloseErr) {
      logger.warn(`[RetentionService] Auto-closing resolved tickets error: ${autoCloseErr.message}`);
    } else {
      result.autoClosed = autoCloseData?.length || 0;
    }
  } catch (err) {
    logger.warn(`[RetentionService] Auto-closing resolved tickets exception: ${err.message}`);
  }

  // 2. Purge closed tickets older than 90 days + clean up R2 attachments
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const { data: expiredTickets, error: fetchErr } = await supabase
      .from('store_support_tickets')
      .select('id')
      .eq('status', 'closed')
      .lt('updated_at', ninetyDaysAgo)
      .limit(100);

    if (fetchErr) {
      logger.warn(`[RetentionService] Fetching expired tickets error: ${fetchErr.message}`);
      return result;
    }

    if (!expiredTickets || expiredTickets.length === 0) return result;

    const ticketIds = expiredTickets.map((t) => t.id);

    // Fetch all message attachments for these tickets
    const { data: messages } = await supabase
      .from('store_support_messages')
      .select('attachments')
      .in('ticket_id', ticketIds);

    const attachmentUrls = [];
    (messages || []).forEach((msg) => {
      if (Array.isArray(msg.attachments)) {
        msg.attachments.forEach((att) => {
          if (typeof att === 'string') attachmentUrls.push(att);
          else if (att && typeof att.url === 'string') attachmentUrls.push(att.url);
        });
      }
    });

    // Delete attachments from Cloudflare R2
    if (attachmentUrls.length > 0) {
      const delRes = await safeDeleteR2Objects(attachmentUrls);
      result.deletedAttachments = delRes.deleted;
    }

    // Delete tickets (cascades to store_support_messages via FK)
    const { error: delErr } = await supabase
      .from('store_support_tickets')
      .delete()
      .in('id', ticketIds);

    if (!delErr) {
      result.purgedTickets = ticketIds.length;
    } else {
      logger.error(`[RetentionService] Error deleting expired tickets: ${delErr.message}`);
    }
  } catch (err) {
    logger.error(`[RetentionService] Purging expired tickets exception: ${err.message}`);
  }

  return result;
}

/**
 * Purge resolved/dismissed platform abuse reports older than 90 days + delete R2 evidence.
 */
async function cleanupResolvedAbuseReports() {
  const result = { purgedReports: 0, deletedEvidenceFiles: 0 };
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data: expiredReports, error: fetchErr } = await supabase
      .from('platform_abuse_reports')
      .select('id, evidence_urls')
      .in('status', ['resolved', 'dismissed'])
      .lt('updated_at', ninetyDaysAgo)
      .limit(100);

    if (fetchErr) {
      logger.warn(`[RetentionService] Fetching expired abuse reports error: ${fetchErr.message}`);
      return result;
    }

    if (!expiredReports || expiredReports.length === 0) return result;

    const reportIds = expiredReports.map((r) => r.id);
    const evidenceUrls = [];
    expiredReports.forEach((r) => {
      if (Array.isArray(r.evidence_urls)) {
        r.evidence_urls.forEach((url) => {
          if (typeof url === 'string') evidenceUrls.push(url);
        });
      }
    });

    if (evidenceUrls.length > 0) {
      const delRes = await safeDeleteR2Objects(evidenceUrls);
      result.deletedEvidenceFiles = delRes.deleted;
    }

    const { error: delErr } = await supabase
      .from('platform_abuse_reports')
      .delete()
      .in('id', reportIds);

    if (!delErr) {
      result.purgedReports = reportIds.length;
    }
  } catch (err) {
    logger.error(`[RetentionService] Abuse reports cleanup exception: ${err.message}`);
  }

  return result;
}

/**
 * Purge frontend error logs older than 48 hours (Zero DB Bloat).
 */
async function cleanupClientErrorLogs() {
  const now = new Date();
  const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

  try {
    const { data, error } = await supabase
      .from('client_error_logs')
      .delete()
      .lt('created_at', fortyEightHoursAgo)
      .select('id');

    if (error) {
      logger.warn(`[RetentionService] Client error logs cleanup error: ${error.message}`);
      return { purged: 0 };
    }
    return { purged: data?.length || 0 };
  } catch (err) {
    logger.warn(`[RetentionService] Client error logs cleanup exception: ${err.message}`);
    return { purged: 0 };
  }
}

/**
 * Purge raw analytics events older than 60 days.
 */
async function cleanupAnalyticsEvents() {
  const now = new Date();
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data, error } = await supabase
      .from('analytics_events')
      .delete()
      .lt('created_at', sixtyDaysAgo)
      .select('id');

    if (error) {
      logger.warn(`[RetentionService] Analytics events cleanup error: ${error.message}`);
      return { purged: 0 };
    }
    return { purged: data?.length || 0 };
  } catch (err) {
    logger.warn(`[RetentionService] Analytics events cleanup exception: ${err.message}`);
    return { purged: 0 };
  }
}

/**
 * Purge delivered or stale failed notifications older than 14 days.
 */
async function cleanupNotificationQueue() {
  const now = new Date();
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data: sentData } = await supabase
      .from('notification_queue')
      .delete()
      .eq('status', 'sent')
      .lt('updated_at', fourteenDaysAgo)
      .select('id');

    const { data: failedData } = await supabase
      .from('notification_queue')
      .delete()
      .eq('status', 'failed')
      .gte('retry_count', 5)
      .lt('updated_at', fourteenDaysAgo)
      .select('id');

    return {
      purgedSent: sentData?.length || 0,
      purgedFailed: failedData?.length || 0,
    };
  } catch (err) {
    logger.warn(`[RetentionService] Notification queue cleanup exception: ${err.message}`);
    return { purgedSent: 0, purgedFailed: 0 };
  }
}

/**
 * Purge login logs older than 60 days.
 */
async function cleanupUserLoginLogs() {
  const now = new Date();
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data, error } = await supabase
      .from('user_login_logs')
      .delete()
      .lt('created_at', sixtyDaysAgo)
      .select('id');

    if (error) {
      logger.warn(`[RetentionService] User login logs cleanup error: ${error.message}`);
      return { purged: 0 };
    }
    return { purged: data?.length || 0 };
  } catch (err) {
    logger.warn(`[RetentionService] User login logs cleanup exception: ${err.message}`);
    return { purged: 0 };
  }
}

/**
 * Purge expired impersonation handoff codes and stale sessions.
 */
async function cleanupStaleImpersonationSessions() {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data: expiredCodes } = await supabase
      .from('impersonation_handoff_codes')
      .delete()
      .lt('expires_at', now.toISOString())
      .select('id');

    const { data: oldSessions } = await supabase
      .from('impersonation_sessions')
      .delete()
      .lt('created_at', sevenDaysAgo)
      .select('id');

    return {
      purgedCodes: expiredCodes?.length || 0,
      purgedSessions: oldSessions?.length || 0,
    };
  } catch (err) {
    logger.warn(`[RetentionService] Impersonation cleanup exception: ${err.message}`);
    return { purgedCodes: 0, purgedSessions: 0 };
  }
}

/**
 * Purge orphaned WhatsApp sessions belonging to removed or inactive accounts,
 * and permanently purge dead Baileys lid-mapping bloat keys.
 */
async function cleanupOrphanedWhatsAppSessions() {
  try {
    const { data: validAccounts } = await supabase
      .from('whatsapp_accounts')
      .select('id');

    const validIds = (validAccounts || []).map((a) => a.id).filter(Boolean);
    let deletedSessions = [];
    if (validIds.length > 0) {
      const { data, error } = await supabase
        .from('whatsapp_sessions')
        .delete()
        .not('whatsapp_account_id', 'in', `(${validIds.join(',')})`)
        .select('id');

      if (error) {
        logger.warn(`[RetentionService] WhatsApp sessions cleanup error: ${error.message}`);
      } else {
        deletedSessions = data || [];
      }
    }

    // Always purge dead Baileys bloat keys (lid-mapping, sender-key, app-state-sync)
    await Promise.allSettled([
      supabase.from('whatsapp_sessions').delete().like('id', '%:lid-mapping-%'),
      supabase.from('whatsapp_sessions').delete().like('id', '%:sender-key-%'),
      supabase.from('whatsapp_sessions').delete().like('id', '%:app-state-sync-%')
    ]);

    // Reclaim physical disk pages automatically
    await supabase.rpc('compact_storage_tables').catch(() => {});

    return { purgedOrphanSessions: deletedSessions?.length || 0 };
  } catch (err) {
    logger.warn(`[RetentionService] WhatsApp sessions cleanup exception: ${err.message}`);
    return { purgedOrphanSessions: 0 };
  }
}

/**
 * Purge stale cart draft sessions older than 14 days.
 */
async function cleanupStaleCartSessions() {
  const now = new Date();
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data, error } = await supabase
      .from('cart_sessions')
      .delete()
      .lt('last_interaction_at', fourteenDaysAgo)
      .select('id');

    if (error) {
      // Table might not exist yet if migration pending, warn gracefully
      logger.warn(`[RetentionService] Stale cart sessions cleanup error: ${error.message}`);
      return { purged: 0 };
    }
    return { purged: data?.length || 0 };
  } catch (err) {
    logger.warn(`[RetentionService] Stale cart sessions cleanup exception: ${err.message}`);
    return { purged: 0 };
  }
}

/**
 * Master entrypoint: runs all retention and garbage collection routines in parallel.
 */
async function runMasterRetentionCleanup() {
  const startTime = Date.now();
  logger.info(' [MasterRetention] Starting comprehensive platform garbage collection...');

  const [
    proofsResult,
    supportResult,
    abuseResult,
    clientErrorsResult,
    analyticsResult,
    notificationsResult,
    loginLogsResult,
    impersonationResult,
    whatsappSessionsResult,
    cartSessionsResult,
  ] = await Promise.all([
    runProofRetentionCleanup().catch((err) => ({ error: err.message })),
    cleanupResolvedSupportTickets().catch((err) => ({ error: err.message })),
    cleanupResolvedAbuseReports().catch((err) => ({ error: err.message })),
    cleanupClientErrorLogs().catch((err) => ({ error: err.message })),
    cleanupAnalyticsEvents().catch((err) => ({ error: err.message })),
    cleanupNotificationQueue().catch((err) => ({ error: err.message })),
    cleanupUserLoginLogs().catch((err) => ({ error: err.message })),
    cleanupStaleImpersonationSessions().catch((err) => ({ error: err.message })),
    cleanupOrphanedWhatsAppSessions().catch((err) => ({ error: err.message })),
    cleanupStaleCartSessions().catch((err) => ({ error: err.message })),
  ]);

  const durationMs = Date.now() - startTime;
  logger.info(` [MasterRetention] Platform garbage collection completed in ${durationMs}ms`);

  const summary = {
    success: true,
    timestamp: new Date().toISOString(),
    durationMs,
    paymentProofs: proofsResult,
    supportTickets: supportResult,
    abuseReports: abuseResult,
    clientErrorLogs: clientErrorsResult,
    analyticsEvents: analyticsResult,
    notifications: notificationsResult,
    loginLogs: loginLogsResult,
    impersonation: impersonationResult,
    whatsappSessions: whatsappSessionsResult,
    cartSessions: cartSessionsResult,
  };

  // Persist run metrics to system_settings for Platform Health monitoring
  try {
    await supabase.from('system_settings').upsert({
      key: 'last_retention_cron_run',
      value: JSON.stringify(summary),
    }, { onConflict: 'key' });
  } catch (saveErr) {
    logger.warn('[MasterRetention] Failed to record run in system_settings:', saveErr.message);
  }

  return summary;
}

let retentionCronTimer = null;
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // Run daily

function startRetentionCron() {
  if (retentionCronTimer) return;
  logger.info('[RetentionService] Initializing background retention cleanup cron (daily schedule)...');
  // Delay first run slightly after boot (45 seconds) so database/server boot is completely smooth
  setTimeout(() => {
    runMasterRetentionCleanup().catch((err) => logger.warn('[RetentionService] Initial cleanup run failed:', err.message));
  }, 45000);

  retentionCronTimer = setInterval(() => {
    runMasterRetentionCleanup().catch((err) => logger.warn('[RetentionService] Periodic cleanup run failed:', err.message));
  }, RETENTION_INTERVAL_MS);
}

function stopRetentionCron() {
  if (retentionCronTimer) {
    clearInterval(retentionCronTimer);
    retentionCronTimer = null;
  }
}

module.exports = {
  runMasterRetentionCleanup,
  cleanupResolvedSupportTickets,
  cleanupResolvedAbuseReports,
  cleanupClientErrorLogs,
  cleanupAnalyticsEvents,
  cleanupNotificationQueue,
  cleanupUserLoginLogs,
  cleanupStaleImpersonationSessions,
  cleanupOrphanedWhatsAppSessions,
  cleanupStaleCartSessions,
  startRetentionCron,
  stopRetentionCron,
};

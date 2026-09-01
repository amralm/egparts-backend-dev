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
 * Purge frontend error logs older than 30 days.
 */
async function cleanupClientErrorLogs() {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data, error } = await supabase
      .from('client_error_logs')
      .delete()
      .lt('created_at', thirtyDaysAgo)
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
 * Master entrypoint: runs all retention and garbage collection routines in parallel.
 */
async function runMasterRetentionCleanup() {
  const startTime = Date.now();
  logger.info('🚀 [MasterRetention] Starting comprehensive platform garbage collection...');

  const [
    proofsResult,
    supportResult,
    abuseResult,
    clientErrorsResult,
    analyticsResult,
    notificationsResult,
    loginLogsResult,
    impersonationResult,
  ] = await Promise.all([
    runProofRetentionCleanup().catch((err) => ({ error: err.message })),
    cleanupResolvedSupportTickets().catch((err) => ({ error: err.message })),
    cleanupResolvedAbuseReports().catch((err) => ({ error: err.message })),
    cleanupClientErrorLogs().catch((err) => ({ error: err.message })),
    cleanupAnalyticsEvents().catch((err) => ({ error: err.message })),
    cleanupNotificationQueue().catch((err) => ({ error: err.message })),
    cleanupUserLoginLogs().catch((err) => ({ error: err.message })),
    cleanupStaleImpersonationSessions().catch((err) => ({ error: err.message })),
  ]);

  const durationMs = Date.now() - startTime;
  logger.info(`✅ [MasterRetention] Platform garbage collection completed in ${durationMs}ms`);

  return {
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
  };
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
};

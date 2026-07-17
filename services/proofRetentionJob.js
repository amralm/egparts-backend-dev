/**
 * Payment Proof Retention Job
 * Runs on a schedule to delete expired payment proof images from Cloudflare R2.
 *
 * Lifecycle of a proof image:
 *   uploaded → verified → archived → expired → DELETED (by this job)
 *
 * The retention period is per-store (via site_settings.proof_retention_days).
 * Default is 90 days if not set.
 *
 * Supported retention values (days):
 *   0   → delete immediately after approval (handled at approve time, not here)
 *   30  → delete 30 days after approval
 *   90  → delete 90 days after approval  (default)
 *   365 → delete 365 days after approval
 *  -1   → never delete (forever)
 *
 * This job runs once every 24 hours.
 */

const { supabase } = require('./supabase');
const r2 = require('./r2StorageService');
const logger = require('../utils/logger');
const subscriptionLimitService = require('./subscriptionLimitService');

const JOB_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_RETENTION_DAYS = 90;

async function decrementWithRetry(storeId, intentId, proof, retries = 3) {
  if (proof.quota_bytes === undefined) {
    logger.warn(`[ProofRetentionJob] Legacy receipt (no quota_bytes) deleted for intent ${intentId}. Skipping storage decrement.`);
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await subscriptionLimitService.decrementFeatureUsage(storeId, 'uploaded_files', 1);
      if (proof.quota_bytes > 0) {
        await subscriptionLimitService.decrementFeatureUsage(storeId, 'storage_bytes', proof.quota_bytes);
      }
      return; // Success
    } catch (err) {
      if (attempt === retries) {
        logger.error(`[ProofRetentionJob] FAILED_QUOTA_DECREMENT: storeId=${storeId}, intentId=${intentId}, r2_key=${proof.r2_key}, bytes=${proof.quota_bytes || 0}. Manual reconciliation required.`);
      } else {
        await new Promise(r => setTimeout(r, 1000 * attempt)); // Exponential backoff: 1s, 2s...
      }
    }
  }
}

async function runProofRetentionCleanup() {
  logger.info('[ProofRetentionJob] Starting payment proof retention cleanup...');

  try {
    // Find all payment_intents with manual_wallet provider where:
    // - status is 'captured' (approved by merchant)
    // - proof exists (r2_key is set)
    // - lifecycle_status is NOT 'deleted'
    const { data: intents, error } = await supabase
      .from('payment_intents')
      .select('id, store_id, metadata, updated_at')
      .eq('provider', 'manual_wallet')
      .eq('status', 'captured')
      .not('metadata->proof->r2_key', 'is', null);

    if (error) {
      logger.error(`[ProofRetentionJob] Error fetching intents: ${error.message}`);
      return;
    }

    if (!intents || intents.length === 0) {
      logger.info('[ProofRetentionJob] No proof images to evaluate.');
      return;
    }

    logger.info(`[ProofRetentionJob] Evaluating ${intents.length} proof images...`);

    // Group by store_id to fetch retention settings in batch
    const storeIds = [...new Set(intents.map((i) => i.store_id))];
    const { data: settingsRows } = await supabase
      .from('site_settings')
      .select('store_id, proof_retention_days')
      .in('store_id', storeIds);

    const retentionMap = {};
    for (const row of settingsRows || []) {
      retentionMap[row.store_id] = row.proof_retention_days ?? DEFAULT_RETENTION_DAYS;
    }

    let deletedCount = 0;

    for (const intent of intents) {
      const proof = intent.metadata?.proof;
      if (!proof?.r2_key) continue;
      if (proof.lifecycle_status === 'deleted') continue;

      const retentionDays = retentionMap[intent.store_id] ?? DEFAULT_RETENTION_DAYS;

      // -1 means "keep forever"
      if (retentionDays === -1) continue;

      // Calculate expiry: approved_at + retentionDays
      const approvedAt = new Date(intent.metadata?.approved_at || intent.updated_at);
      const expiryDate = new Date(approvedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
      const now = new Date();

      if (now < expiryDate) continue; // Not expired yet

      // Delete from R2
      try {
        await r2.deleteObject(proof.r2_key);
        logger.info(`[ProofRetentionJob] Deleted R2 object: ${proof.r2_key}`);

        // Decrement quota with retry
        await decrementWithRetry(intent.store_id, intent.id, proof);

        // Mark as deleted in metadata (keep audit trail, remove the actual file reference)
        const updatedProof = {
          ...proof,
          r2_key: null,          // Remove reference (file is gone)
          lifecycle_status: 'deleted',
          deleted_at: now.toISOString(),
          deleted_reason: `Retention policy: ${retentionDays} days`,
        };

        await supabase
          .from('payment_intents')
          .update({
            metadata: {
              ...(intent.metadata || {}),
              proof: updatedProof,
            },
          })
          .eq('id', intent.id);

        deletedCount++;
      } catch (deleteErr) {
        logger.error(`[ProofRetentionJob] Failed to delete ${proof.r2_key}: ${deleteErr.message}`);
      }
    }

    logger.info(`[ProofRetentionJob] Cleanup complete. Deleted ${deletedCount} proof images.`);
  } catch (err) {
    logger.error(`[ProofRetentionJob] Fatal error: ${err.message}`);
  }
}

/**
 * Delete a proof immediately after merchant approval (for stores with retention = 0 days).
 * Called from the approve route.
 *
 * @param {string} intentId
 * @param {string} storeId
 * @param {object} metadata  - current intent metadata
 */
async function deleteProofImmediately(intentId, storeId, metadata) {
  const r2Key = metadata?.proof?.r2_key;
  if (!r2Key) return;

  try {
    await r2.deleteObject(r2Key);

    await decrementWithRetry(storeId, intentId, metadata.proof);

    const updatedProof = {
      ...(metadata.proof || {}),
      r2_key: null,
      lifecycle_status: 'deleted',
      deleted_at: new Date().toISOString(),
      deleted_reason: 'Retention policy: 0 days (immediate)',
    };

    await supabase
      .from('payment_intents')
      .update({ metadata: { ...metadata, proof: updatedProof } })
      .eq('id', intentId);

    logger.info(`[ProofRetentionJob] Immediately deleted proof for intent ${intentId}`);
  } catch (err) {
    logger.error(`[ProofRetentionJob] Failed to immediately delete proof for ${intentId}: ${err.message}`);
  }
}

/**
 * Start the retention cleanup cron (runs every 24 hours).
 */
function startProofRetentionJob() {
  logger.info('[ProofRetentionJob] Scheduled: runs every 24 hours.');
  // Run once on startup, then every 24h
  runProofRetentionCleanup();
  setInterval(runProofRetentionCleanup, JOB_INTERVAL_MS);
}

module.exports = { startProofRetentionJob, deleteProofImmediately };

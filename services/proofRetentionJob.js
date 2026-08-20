'use strict';

/**
 * Durable payment-proof retention.
 *
 * The Web Service timer is only a best-effort fallback. The authoritative
 * deadline and retry state live in payment_proof_retention and are processed
 * by scripts/cleanup-payment-proofs.js from an external Render Cron Job.
 */
const { supabase } = require('./supabase');
const r2 = require('./r2StorageService');
const logger = require('../utils/logger');

const JOB_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;
const LEGACY_FALLBACK_LIMIT = 100;

function normalizeDays(value, fallback = DEFAULT_RETENTION_DAYS) {
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0 || days > MAX_RETENTION_DAYS) return fallback;
  return Math.floor(days);
}

function addDays(date, days) {
  return new Date(new Date(date).getTime() + normalizeDays(days) * 24 * 60 * 60 * 1000);
}

async function getPlatformDefaultRetentionDays() {
  const { data, error } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', 'payment_proof_retention_default_days')
    .maybeSingle();

  if (error) {
    logger.warn(`[ProofRetentionJob] Failed to load platform default: ${error.message}`);
    return DEFAULT_RETENTION_DAYS;
  }
  return normalizeDays(data?.value, DEFAULT_RETENTION_DAYS);
}

async function getStoreRetentionPolicy(storeId) {
  const { data, error } = await supabase
    .from('site_settings')
    .select('proof_retention_days')
    .eq('store_id', storeId)
    .maybeSingle();

  if (!error && data?.proof_retention_days !== null && data?.proof_retention_days !== undefined) {
    const raw = Number(data.proof_retention_days);
    if (Number.isFinite(raw) && raw >= 0 && raw <= MAX_RETENTION_DAYS) {
      return { days: Math.floor(raw), source: 'store_override' };
    }
  }

  return {
    days: await getPlatformDefaultRetentionDays(),
    source: 'platform_default',
  };
}

async function upsertRetentionRecord({
  intentId,
  storeId,
  r2Key,
  quotaBytes = 0,
  quotaFeatureKey = 'uploaded_images',
  submittedAt,
  expiresAt = null,
  status = 'active',
  retentionSource = 'platform_default',
  resetLifecycle = false,
}) {
  const payload = {
    intent_id: intentId,
    store_id: storeId,
    r2_key: r2Key,
    quota_bytes: Math.max(0, Number(quotaBytes) || 0),
    quota_feature_key: quotaFeatureKey === 'uploaded_files' ? 'uploaded_files' : 'uploaded_images',
    submitted_at: submittedAt || new Date().toISOString(),
    expires_at: expiresAt,
    status,
    retention_source: retentionSource,
    updated_at: new Date().toISOString(),
  };
  if (resetLifecycle) {
    payload.deleted_at = null;
    payload.quota_released_at = null;
    payload.deletion_started_at = null;
    payload.attempts = 0;
    payload.last_error = null;
  }

  const { error } = await supabase
    .from('payment_proof_retention')
    .upsert(payload, { onConflict: 'intent_id' });

  if (error) throw error;
}

async function registerProof({ intentId, storeId, r2Key, quotaBytes, submittedAt }) {
  await upsertRetentionRecord({ intentId, storeId, r2Key, quotaBytes, submittedAt, resetLifecycle: true });
}

async function applyDecisionToProof({ intentId, storeId, metadata, approved, decisionAt }) {
  const proof = metadata?.proof;
  if (!proof?.r2_key) return { expiresAt: null, source: approved ? 'platform_default' : 'immediate_rejected' };

  const decidedAt = decisionAt || new Date().toISOString();
  const policy = approved
    ? await getStoreRetentionPolicy(storeId)
    : { days: 0, source: 'immediate_rejected' };
  const expiresAt = approved ? addDays(decidedAt, policy.days).toISOString() : decidedAt;
  const lifecycleStatus = approved ? 'verified' : 'rejected';

  const updatedMetadata = {
    ...(metadata || {}),
    proof: {
      ...proof,
      lifecycle_status: lifecycleStatus,
      proof_expires_at: expiresAt,
      retention_days: policy.days,
      retention_source: policy.source,
    },
  };

  const { error: metadataError } = await supabase
    .from('payment_intents')
    .update({ metadata: updatedMetadata, updated_at: decidedAt })
    .eq('id', intentId)
    .eq('store_id', storeId);
  if (metadataError) throw metadataError;

  await upsertRetentionRecord({
    intentId,
    storeId,
    r2Key: proof.r2_key,
    quotaBytes: proof.quota_bytes,
    quotaFeatureKey: proof.quota_feature_key,
    submittedAt: proof.submitted_at,
    expiresAt,
    status: approved ? 'active' : 'deletion_pending',
    retentionSource: policy.source,
  });

  return { expiresAt, source: policy.source, days: policy.days };
}

async function releaseQuota(intentId) {
  const { data, error } = await supabase.rpc('release_payment_proof_quota', { p_intent_id: intentId });
  if (error) throw error;
  return data || { released: false };
}

async function markDeleted(record, reason) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('payment_proof_retention')
    .update({ status: 'deleted', deleted_at: now, last_error: null, updated_at: now })
    .eq('id', record.id);
  if (error) throw error;

  // Remove the raw key while retaining lifecycle and audit data in metadata.
  const { data: intent } = await supabase
    .from('payment_intents')
    .select('metadata')
    .eq('id', record.intent_id)
    .maybeSingle();
  if (intent?.metadata?.proof) {
    await supabase.from('payment_intents').update({
      metadata: {
        ...(intent.metadata || {}),
        proof: {
          ...intent.metadata.proof,
          r2_key: null,
          lifecycle_status: 'deleted',
          deleted_at: now,
          deleted_reason: reason,
        },
      },
      updated_at: now,
    }).eq('id', record.intent_id);
  }
}

async function deleteRetentionRecord(record, reason = 'Retention policy expired') {
  if (!record?.r2_key || record.status === 'deleted') return { deleted: false, reason: 'already_deleted' };

  const now = new Date().toISOString();
  await supabase.from('payment_proof_retention').update({
    status: 'deletion_pending',
    deletion_started_at: now,
    attempts: Number(record.attempts || 0) + 1,
    updated_at: now,
  }).eq('id', record.id).neq('status', 'deleted');

  try {
    await r2.deleteObject(record.r2_key);
    await releaseQuota(record.intent_id);
    await markDeleted(record, reason);
    return { deleted: true };
  } catch (error) {
    await supabase.from('payment_proof_retention').update({
      status: 'deletion_failed',
      last_error: String(error.message || error).slice(0, 1000),
      updated_at: new Date().toISOString(),
    }).eq('id', record.id);
    logger.error(`[ProofRetentionJob] Deletion failed for ${record.intent_id}: ${error.message}`);
    return { deleted: false, error };
  }
}

async function deleteProofImmediately(intentId, storeId, metadata, customReason = null) {
  const proof = metadata?.proof;
  if (!proof?.r2_key) return { deleted: false, reason: 'no_r2_key' };

  let { data: record } = await supabase
    .from('payment_proof_retention')
    .select('*')
    .eq('intent_id', intentId)
    .eq('store_id', storeId)
    .maybeSingle();

  if (!record) {
    await upsertRetentionRecord({
      intentId,
      storeId,
      r2Key: proof.r2_key,
      quotaBytes: proof.quota_bytes,
      quotaFeatureKey: proof.quota_feature_key,
      submittedAt: proof.submitted_at,
      expiresAt: new Date().toISOString(),
      status: 'deletion_pending',
      retentionSource: 'immediate_rejected',
    });
    ({ data: record } = await supabase.from('payment_proof_retention').select('*').eq('intent_id', intentId).maybeSingle());
  }

  return deleteRetentionRecord(record, customReason || 'Rejected proof: immediate deletion');
}

async function loadDueRecords(limit = 100) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('payment_proof_retention')
    .select('*')
    .in('status', ['active', 'deletion_pending', 'deletion_failed'])
    .not('expires_at', 'is', null)
    .lte('expires_at', now)
    .order('expires_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function cleanupLegacyRecords(limit = LEGACY_FALLBACK_LIMIT) {
  // Compatibility path for receipts uploaded before migration 70. It is
  // intentionally conservative: only records with an explicit decision are
  // considered, and metadata is converted into the durable queue before use.
  const { data: intents, error } = await supabase
    .from('payment_intents')
    .select('id, order_id, store_id, status, metadata, updated_at')
    .eq('provider', 'manual_wallet')
    .in('status', ['captured', 'failed'])
    .not('metadata->proof->r2_key', 'is', null)
    .order('updated_at', { ascending: true })
    .limit(limit);
  if (error) throw error;

  let converted = 0;
  for (const intent of intents || []) {
    const proof = intent.metadata?.proof;
    if (!proof?.r2_key) continue;
    const approved = intent.status === 'captured';
    const expiresAt = proof.proof_expires_at || (approved ? addDays(proof.approved_at || intent.updated_at, DEFAULT_RETENTION_DAYS).toISOString() : new Date().toISOString());
    await upsertRetentionRecord({
      intentId: intent.id,
      storeId: intent.store_id,
      r2Key: proof.r2_key,
      quotaBytes: proof.quota_bytes,
      quotaFeatureKey: proof.quota_feature_key || 'uploaded_images',
      submittedAt: proof.submitted_at || intent.updated_at,
      expiresAt,
      status: approved ? 'active' : 'deletion_pending',
      retentionSource: proof.retention_source || (approved ? 'platform_default' : 'immediate_rejected'),
    });
    converted += 1;
  }
  return converted;
}

async function runProofRetentionCleanup() {
  if (runProofRetentionCleanup.running) return { deleted: 0, converted: 0 };
  runProofRetentionCleanup.running = true;
  try {
    const converted = await cleanupLegacyRecords();
    const records = await loadDueRecords();
    let deleted = 0;
    let failed = 0;
    for (const record of records) {
      const result = await deleteRetentionRecord(record);
      if (result.deleted) deleted += 1;
      else if (result.error) failed += 1;
    }
    logger.info(`[ProofRetentionJob] Cleanup complete: converted=${converted}, deleted=${deleted}, failed=${failed}`);
    return { converted, deleted, failed };
  } catch (error) {
    logger.error(`[ProofRetentionJob] Cleanup failed: ${error.message}`);
    throw error;
  } finally {
    runProofRetentionCleanup.running = false;
  }
}

let retentionTimer = null;
function startProofRetentionJob() {
  if (retentionTimer) return;
  // Fallback only. Production deletion is performed by the external cron.
  logger.info('[ProofRetentionJob] Starting best-effort web fallback; use the external retention cron for production cleanup.');
  runProofRetentionCleanup().catch(() => {});
  retentionTimer = setInterval(() => runProofRetentionCleanup().catch(() => {}), JOB_INTERVAL_MS);
}

function stopProofRetentionJob() {
  if (retentionTimer) clearInterval(retentionTimer);
  retentionTimer = null;
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  getPlatformDefaultRetentionDays,
  getStoreRetentionPolicy,
  registerProof,
  applyDecisionToProof,
  runProofRetentionCleanup,
  startProofRetentionJob,
  stopProofRetentionJob,
  deleteProofImmediately,
};

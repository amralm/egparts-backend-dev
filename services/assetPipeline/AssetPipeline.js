'use strict';

const { v4: uuidv4 } = require('uuid');
const logger             = require('../../utils/logger');
const registry           = require('./AssetRegistry');
const magicBytes         = require('./MagicBytesValidator');
const fileFingerprint    = require('./FileFingerprint');
const imageProcessor     = require('./ImageProcessor');
const virusScanner       = require('./VirusScanner');
const storageService     = require('./StorageService');

// Quota integration — uses existing subscriptionLimitService
const subscriptionLimitService = require('../subscriptionLimitService');

/**
 * AssetPipeline — The single entry point for all file uploads.
 *
 * STATELESS: no database writes. Returns { key, sha256, fingerprint }.
 * Caller is responsible for storing the key in their own table.
 *
 * Pipeline steps:
 *   1. validatePolicy      — AssetRegistry.validatePolicy(policyName)
 *   2. tripleValidation    — MagicBytesValidator (magic + MIME + extension)
 *   3. sizeValidation      — maxSizeBytes check
 *   4. quotaCheck          — subscriptionLimitService.canUpload()
 *   5. fingerprint         — FileFingerprint.compute() (single pass)
 *   6. duplicateDetection  — if policy.duplicateDetection (sha256 lookup skipped in Phase 1)
 *   7. virusScan           — VirusScanner.scan() (NoopScanner)
 *   8. imageProcess        — ImageProcessor.process(buffer, policy, fingerprint)
 *   9. storageUpload       — StorageService.upload() with retry
 *   10. quotaCommit        — commit processed size to quota
 *   11. return result      — { key, sha256, fingerprint, policyVersion, pipelineVersion }
 *
 * Forbidden:
 * - No direct R2 / S3 calls — always through StorageService
 * - No DB writes — always caller's responsibility
 * - No route-level business logic
 */
class AssetPipeline {
  /**
   * Process and upload a file.
   *
   * @param {object} params
   * @param {Buffer}  params.buffer         — raw file bytes from multer
   * @param {string}  params.mimetype        — MIME type (multer)
   * @param {string}  params.originalname    — original filename (multer)
   * @param {string}  params.policyName      — e.g. 'product', 'receipt'
   * @param {string}  params.storeId         — required for storage key + quota
   * @param {string}  [params.uploadedBy]    — user ID for logging
   * @param {string}  [params.correlationId] — from req.correlationId
   * @param {object}  [params.extraMetadata] — additional key-value pairs stored on the R2 object.
   *                                           Use for audit, GC, or cost-allocation tags.
   *                                           Keys must be lowercase strings. Values must be strings.
   *                                           No business logic may depend on these values.
   *                                           Example: { owner_type: 'payment_intent', owner_id: uuid }
   *
   * @returns {Promise<{
   *   key: string,
   *   sha256: string,
   *   duplicate: boolean,
   *   fingerprint: object,
   *   policyVersion: number,
   *   pipelineVersion: number,
   *   correlationId: string
   * }>}
   */
  async process({ buffer, mimetype, originalname, policyName, storeId, uploadedBy, correlationId, extraMetadata }) {
    const corrId = correlationId || `req_${uuidv4()}`;
    const ctx = { policyName, storeId, uploadedBy, correlationId: corrId };

    logger.info('[AssetPipeline] Upload started', ctx);

    const startMs = Date.now(); // Pipeline Metrics

    // ── Step 1: Validate policy ──────────────────────────────────────────────
    registry.validatePolicy(policyName);
    const policy = registry.getPolicy(policyName);

    // ── Step 2: Triple validation (magic bytes + MIME + extension) ───────────
    const { ext: originalExt } = magicBytes.validate(
      buffer, mimetype, originalname, policy.allowedMimeTypes
    );

    // ── Step 3: Size validation ──────────────────────────────────────────────
    if (buffer.length > policy.maxSizeBytes) {
      const maxMB = (policy.maxSizeBytes / (1024 * 1024)).toFixed(0);
      throw Object.assign(
        new Error(`FILE_TOO_LARGE: Maximum file size for '${policyName}' is ${maxMB} MB`),
        { code: 'FILE_TOO_LARGE', statusCode: 400 }
      );
    }

    // ── Step 4: Quota check (BEFORE processing — avoid wasting CPU) ────────
    // Skipped for policies that declare skipStorageQuota = true (e.g. ReceiptPolicy).
    // Evidence-based decision: see ReceiptPolicy.skipStorageQuota for rationale.
    let quotaKey = null;
    if (!policy.skipStorageQuota) {
      quotaKey = `upload_${uuidv4()}`;
      const reserved = await subscriptionLimitService.reserveFeatureUsage(
        storeId, 'uploaded_images', 1, quotaKey, 15
      );
      if (!reserved) {
        throw Object.assign(
          new Error('QUOTA_EXCEEDED: Upload quota limit reached for this store'),
          { code: 'QUOTA_EXCEEDED', statusCode: 403 }
        );
      }
    }

    try {
      // ── Step 5: File fingerprint (single pass: SHA256 + image metadata) ────
      const fingerprint = await fileFingerprint.compute(buffer);

      // ── Step 6: Duplicate detection (if policy enables it) ──────────────────
      // Phase 1: in-memory check not possible without DB. Skipped.
      // Phase 2: query media_files by sha256 + policyName + storeId + ownerType + ownerId
      const duplicate = false;

      // ── Step 7: Virus scan (NoopScanner — always clean) ─────────────────────
      if (policy.virusScanRequired) {
        const scan = await virusScanner.scan(buffer);
        if (!scan.clean) {
          throw Object.assign(
            new Error(`VIRUS_DETECTED: File failed security scan${scan.threat ? `: ${scan.threat}` : ''}`),
            { code: 'VIRUS_DETECTED', statusCode: 422 }
          );
        }
      }

      // ── Step 8: Image processing ─────────────────────────────────────────────
      const { buffer: processedBuffer, ext } = await imageProcessor.process(
        buffer, policy, fingerprint
      );

      // ── Step 9: Generate storage key via policy ──────────────────────────────
      const fileId = uuidv4();
      const key    = policy.generateStorageKey(storeId, fileId, ext);

      logger.info('[AssetPipeline] Uploading to storage', {
        ...ctx, key,
        originalSize: buffer.length,
        processedSize: processedBuffer.length,
      });

      // ── Step 10: Upload to storage (with retry) ───────────────────────────
      await storageService.upload(processedBuffer, key, {
        contentType: ext === 'webp' ? 'image/webp'
                   : ext === 'pdf'  ? 'application/pdf'
                   : mimetype,
        metadata: {
          store_id:       storeId,
          uploaded_by:    uploadedBy || 'unknown',
          policy:         policyName,
          policy_version: String(policy.version),
          correlation_id: corrId,
          // Caller-supplied audit/GC tags. No pipeline logic depends on these.
          ...(extraMetadata && typeof extraMetadata === 'object' ? extraMetadata : {}),
        },
        correlationId: corrId,
      });

      // ── Step 11: Commit quota — with Compensation Delete on failure ────────────
      // Pattern: Upload succeeded → try to commit quota.
      // If commit fails → delete the just-uploaded object from R2 immediately.
      // This prevents orphan objects without needing a background GC in Phase 1.
      // Skipped entirely for quota-exempt policies.
      if (!policy.skipStorageQuota && quotaKey) {
        try {
          await subscriptionLimitService.commitFeatureUsage(quotaKey);
        } catch (commitErr) {
          logger.error('[AssetPipeline] Quota commit failed — executing compensation delete', {
            ...ctx, key, error: commitErr.message,
          });
          try {
            await storageService.delete(key, { correlationId: corrId });
            logger.info('[AssetPipeline] Compensation delete succeeded — no orphan created', { key, corrId });
          } catch (deleteErr) {
            // Compensation delete failed — object is now a true orphan.
            // Log with ORPHAN_OBJECT tag so a future GC job can find it via log query.
            logger.error('[AssetPipeline] ORPHAN_OBJECT: compensation delete failed — manual cleanup required', {
              key, correlationId: corrId, store_id: storeId, policy: policyName,
              commitError: commitErr.message, deleteError: deleteErr.message,
            });
          }
          throw commitErr; // propagate the commit error to the caller
        }
      }


      const processingMs = Date.now() - startMs;

      logger.info('[AssetPipeline] Upload complete', {
        ...ctx, key,
        sha256: fingerprint.sha256.slice(0, 8) + '...',
        originalSize: buffer.length,
        processedSize: processedBuffer.length,
        compressionRatio: buffer.length > 0
          ? Math.round((1 - processedBuffer.length / buffer.length) * 100)
          : 0,
        processingMs,
      });

      return {
        key,
        sha256:         fingerprint.sha256,
        duplicate,
        fingerprint: {
          width:             fingerprint.width,
          height:            fingerprint.height,
          format:            ext,
          orientation:       fingerprint.orientation,
          originalSizeBytes: buffer.length,
          processedSizeBytes: processedBuffer.length,
        },
        metrics: {
          processedBytes:   processedBuffer.length,
          savedBytes:       Math.max(0, buffer.length - processedBuffer.length),
          compressionRatio: buffer.length > 0
            ? Math.round((1 - processedBuffer.length / buffer.length) * 100)
            : 0,
          processingMs,
        },
        policyVersion:   policy.version,
        pipelineVersion: policy.pipelineVersion,
        correlationId:   corrId,
      };

    } catch (err) {
      // Rollback quota reservation on any failure (only if quota was reserved)
      if (!policy.skipStorageQuota && quotaKey) {
        try {
          await subscriptionLimitService.rollbackFeatureUsage(quotaKey);
        } catch (rollbackErr) {
          logger.error('[AssetPipeline] Quota rollback failed', {
            ...ctx, error: rollbackErr.message,
          });
        }
      }
      logger.error('[AssetPipeline] Upload failed', { ...ctx, error: err.message, code: err.code });
      throw err;
    }
  }
}

module.exports = new AssetPipeline();

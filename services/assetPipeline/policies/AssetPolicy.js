'use strict';

/**
 * AssetPolicy — Base Class for all upload policies.
 *
 * Rules:
 * - Every concrete policy MUST extend this class.
 * - Policy determines visibility, not the request.
 * - Policy owns its own storage key generation.
 * - ImageProcessor reads policy values — no hardcoded logic outside.
 */
class AssetPolicy {
  // ─── Identity ────────────────────────────────────────────────────────────
  get name()             { throw new Error(`${this.constructor.name} must implement get name()`) }
  get version()          { return 1 }           // Policy version — bump when logic changes
  get pipelineVersion()  { return 1 }           // Pipeline version — bump when orchestrator changes

  // ─── Size Limits ─────────────────────────────────────────────────────────
  get maxSizeBytes()     { throw new Error(`${this.constructor.name} must implement get maxSizeBytes()`) }
  get maxLongEdge()      { return 6000 }        // px — longest side (handles portrait + landscape)
  get maxMegapixels()    { return 36 }          // 6000×6000 safety net

  // ─── Processing Thresholds ───────────────────────────────────────────────
  get optimizeFromBytes(){ return 1 * 1024 * 1024 }   // < this → no compression (just stripMeta)
  get resizeFromBytes()  { return 5 * 1024 * 1024 }   // > this → resize + optimize

  // ─── Quality ─────────────────────────────────────────────────────────────
  get quality()          { return 82 }          // 0–100
  get convertToWebP()    { return true }        // convert JPEG/PNG → WebP
  get pngOptimizationProfile() { return 'lossless' } // 'lossless' | 'receipt'

  // ─── Access ──────────────────────────────────────────────────────────────
  get visibility()       { return 'public' }    // 'public' | 'private' — Policy decides, not request
  get allowedMimeTypes() {
    return ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];
  }

  // ─── Features ────────────────────────────────────────────────────────────
  get duplicateDetection() { return false }     // SHA256-based dedup — opt-in per policy
  get virusScanRequired()  { return false }     // Future: ClamAV hook

  /**
   * skipStorageQuota — when true, this policy's uploads do NOT count against
   * the store's upload_images / storage_bytes quota.
   *
   * Use ONLY for transient or system-generated assets that are automatically
   * deleted by a background job and whose lifecycle is not controlled by the merchant.
   *
   * If you set this to true, document the reason in the concrete Policy class.
   */
  get skipStorageQuota()   { return false }     // Default: all uploads count against quota

  // ─── Storage Key ─────────────────────────────────────────────────────────
  /**
   * Generates the R2 object key for this asset.
   * Each Policy owns its path structure — no hardcoded paths in AssetPipeline.
   *
   * @param {string} storeId
   * @param {string} fileId   — UUID
   * @param {string} ext      — file extension (e.g. 'webp', 'jpg', 'pdf')
   * @returns {string}
   */
  generateStorageKey(storeId, fileId, ext) {
    return `stores/${storeId}/${this.visibility}/${this.name}s/${fileId}.${ext}`;
  }
}

module.exports = AssetPolicy;

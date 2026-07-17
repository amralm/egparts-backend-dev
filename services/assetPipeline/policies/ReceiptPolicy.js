'use strict';
const AssetPolicy = require('./AssetPolicy');

/**
 * ReceiptPolicy — Payment Proof Images
 *
 * CRITICAL RULES:
 * - visibility is ALWAYS private (payment proof, not display asset)
 * - convertToWebP is FALSE (preserve original format for legal evidence)
 * - duplicateDetection is FALSE (same receipt can be for different payments)
 * - Resize ONLY if Long Edge > maxLongEdge (6000px) to protect QR/Barcode/Reference readability
 * - Light compression only (quality: 92) — this is evidence, not display media
 */
class ReceiptPolicy extends AssetPolicy {
  get name()              { return 'receipt' }
  get maxSizeBytes()      { return 15 * 1024 * 1024 }  // 15 MB
  get maxLongEdge()       { return 2500 }               // resize ONLY if long edge > this
  get optimizeFromBytes() { return 0 }                 // 0 MB — ALWAYS optimize (catch small uncompressed screenshots)
  get resizeFromBytes()   { return 2 * 1024 * 1024 }   // 2 MB — resize above this
  get quality()           { return 92 }                 // High quality — legal evidence
  get convertToWebP()     { return false }              // Preserve original format
  get pngOptimizationProfile() { return 'receipt' }     // Aggressive PNG optimization for screenshots
  get visibility()        { return 'private' }
  get duplicateDetection(){ return false }
  get allowedMimeTypes()  { return ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] }


  generateStorageKey(storeId, fileId, ext) {
    return `stores/${storeId}/private/receipts/${fileId}.${ext}`;
  }
}

module.exports = new ReceiptPolicy();

'use strict';

const sharp = require('sharp');

/**
 * ImageProcessor — sharp-based image processing.
 *
 * Single entry point: process(buffer, policy)
 * The Policy determines what happens:
 *   < optimizeFromBytes → stripMeta only (no compression)
 *   < resizeFromBytes   → stripMeta + autoOrient + optimize (light compression)
 *   >= resizeFromBytes  → stripMeta + autoOrient + resize + optimize
 *
 * Non-image buffers (PDFs, CSVs) pass through unchanged.
 *
 * Receipt special case:
 *   Resize only if longest edge exceeds policy.maxLongEdge (default 6000px).
 *   This protects QR codes, barcodes, and reference numbers from losing readability.
 */
class ImageProcessor {
  /**
   * Process a buffer according to its policy.
   *
   * @param {Buffer} buffer
   * @param {object} policy         — AssetPolicy instance
   * @param {object} fingerprint    — { width, height, format, isImage } from FileFingerprint
   * @returns {Promise<{ buffer: Buffer, ext: string }>}
   */
  async process(buffer, policy, fingerprint) {
    // Non-image files: pass through unchanged
    if (!fingerprint.isImage) {
      return { buffer, ext: fingerprint.format || 'bin' };
    }

    // SVG: pass through (not rasterizable safely)
    if (fingerprint.format === 'svg') {
      return { buffer, ext: 'svg' };
    }

    const originalSize = buffer.length;

    // Start sharp pipeline — always strip EXIF metadata (privacy + security)
    let pipeline = sharp(buffer).rotate(); // .rotate() = autoOrient from EXIF

    // ── Decision Tree ────────────────────────────────────────────────────────
    if (originalSize < policy.optimizeFromBytes) {
      // SMALL: strip metadata only, no compression
      pipeline = pipeline.withMetadata(false);
    } else if (originalSize < policy.resizeFromBytes) {
      // MEDIUM: optimize without resize
      pipeline = this._applyCompression(pipeline, policy, fingerprint, false);
    } else {
      // LARGE: resize + optimize
      pipeline = this._applyCompression(pipeline, policy, fingerprint, true);
    }

    // Output format
    const outputExt = (policy.convertToWebP && fingerprint.format !== 'gif')
      ? 'webp'
      : (fingerprint.format || 'jpg');

    if (outputExt === 'webp') pipeline = pipeline.webp({ quality: policy.quality });
    else if (outputExt === 'jpg') pipeline = pipeline.jpeg({ quality: policy.quality, mozjpeg: true });
    else if (outputExt === 'png') {
      if (policy.pngOptimizationProfile === 'receipt') {
        pipeline = pipeline.png({ palette: true, compressionLevel: 9 });
      } else {
        pipeline = pipeline.png({ quality: policy.quality, compressionLevel: 7 });
      }
    }

    const processedBuffer = await pipeline.toBuffer();
    return { buffer: processedBuffer, ext: outputExt };
  }

  /**
   * Apply resize (optional) and compression.
   * Respects policy.maxLongEdge for resize decisions.
   * Receipt policy: only resizes if the longest edge exceeds maxLongEdge.
   */
  _applyCompression(pipeline, policy, fingerprint, shouldResize) {
    if (!shouldResize) {
      return pipeline.withMetadata(false);
    }

    const { width = 0, height = 0 } = fingerprint;
    const longEdge = Math.max(width, height);

    // Only resize if the long edge exceeds the policy limit
    if (longEdge > policy.maxLongEdge) {
      pipeline = pipeline.resize(policy.maxLongEdge, policy.maxLongEdge, {
        fit: 'inside',          // preserve aspect ratio
        withoutEnlargement: true,
      });
    }

    return pipeline.withMetadata(false);
  }
}

module.exports = new ImageProcessor();

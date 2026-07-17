'use strict';

const crypto = require('crypto');
const sharp  = require('sharp');

/**
 * FileFingerprint — Single-pass file identity computation.
 *
 * Computes in one pass (no double read):
 * - sha256 hash of the raw buffer
 * - width, height, format, orientation (via sharp metadata)
 *
 * Used for:
 * - Duplicate detection (sha256 + policy + store_id)
 * - Audit trail
 * - Response fingerprint to caller
 */
class FileFingerprint {
  /**
   * Compute fingerprint from a raw buffer.
   * Non-image files (PDFs etc.) return image dimensions as null.
   *
   * @param {Buffer} buffer
   * @returns {Promise<{sha256, width, height, format, orientation, isImage}>}
   */
  async compute(buffer) {
    // SHA256 is synchronous and cheap — always computed
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

    // Attempt to extract image metadata via sharp
    let width = null;
    let height = null;
    let format = null;
    let orientation = null;
    let isImage = false;

    try {
      const meta = await sharp(buffer).metadata();
      isImage     = true;
      width       = meta.width  || null;
      height      = meta.height || null;
      format      = meta.format || null;

      // Determine orientation from dimensions
      if (width && height) {
        if (width > height)       orientation = 'landscape';
        else if (height > width)  orientation = 'portrait';
        else                      orientation = 'square';
      }
    } catch {
      // Not an image — that's fine (PDF, CSV, etc.)
    }

    return { sha256, width, height, format, orientation, isImage };
  }
}

module.exports = new FileFingerprint();

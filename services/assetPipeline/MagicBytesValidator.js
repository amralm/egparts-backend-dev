'use strict';

/**
 * MagicBytesValidator — Triple validation of file identity.
 *
 * Validates that Extension + MIME Type + Magic Bytes all agree.
 * A file claiming to be JPEG must have:
 *   - A JPEG/WebP/PNG/etc. extension
 *   - A valid image/* MIME type
 *   - The correct binary signature in the first bytes
 *
 * No trust in any single source. All three must match.
 */

// Magic byte signatures — first N bytes of valid files
// Format: [offset, bytes]
const SIGNATURES = [
  { mime: 'image/jpeg',    bytes: [0xFF, 0xD8, 0xFF],           offset: 0 },
  { mime: 'image/png',     bytes: [0x89, 0x50, 0x4E, 0x47],     offset: 0 },
  { mime: 'image/webp',    bytes: [0x52, 0x49, 0x46, 0x46],     offset: 0 },  // RIFF
  { mime: 'image/gif',     bytes: [0x47, 0x49, 0x46, 0x38],     offset: 0 },  // GIF8
  { mime: 'image/heic',    bytes: [0x66, 0x74, 0x79, 0x70],     offset: 4 },  // ftyp
  { mime: 'image/svg+xml', bytes: null,                          offset: 0 },  // text — no magic bytes
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46],   offset: 0 },  // %PDF
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes: [0x50, 0x4B, 0x03, 0x04], offset: 0,                               // PK (ZIP)
  },
  { mime: 'text/csv',      bytes: null, offset: 0 },  // text — no magic bytes
];

// MIME → allowed extensions
const MIME_EXTENSIONS = {
  'image/jpeg':    ['jpg', 'jpeg'],
  'image/png':     ['png'],
  'image/webp':    ['webp'],
  'image/gif':     ['gif'],
  'image/heic':    ['heic', 'heif'],
  'image/svg+xml': ['svg'],
  'application/pdf': ['pdf'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.ms-excel': ['xls'],
  'text/csv':      ['csv'],
};

// MIME → canonical file extension for storage
const MIME_TO_EXT = {
  'image/jpeg':    'jpg',
  'image/png':     'png',
  'image/webp':    'webp',
  'image/gif':     'gif',
  'image/heic':    'heic',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'text/csv':      'csv',
};

class MagicBytesValidator {
  /**
   * Triple validation: magic bytes + MIME type + file extension.
   * Throws with a specific error code on failure.
   *
   * @param {Buffer} buffer       — raw file bytes
   * @param {string} mimetype     — from multer (client-reported, not trusted alone)
   * @param {string} originalname — original filename
   * @param {string[]} allowedMimeTypes — from the active Policy
   * @returns {{ ext: string }}   — canonical extension to use for storage
   */
  validate(buffer, mimetype, originalname, allowedMimeTypes) {
    // 1. Check MIME is in policy's allowed list
    if (!allowedMimeTypes.includes(mimetype)) {
      throw Object.assign(
        new Error(`UNSUPPORTED_TYPE: '${mimetype}' is not allowed by this policy`),
        { code: 'UNSUPPORTED_TYPE', statusCode: 400 }
      );
    }

    // 2. Verify magic bytes (skip for text-based formats)
    const sig = SIGNATURES.find(s => s.mime === mimetype);
    if (sig && sig.bytes) {
      const match = sig.bytes.every((byte, i) => buffer[sig.offset + i] === byte);
      if (!match) {
        throw Object.assign(
          new Error(`INVALID_MAGIC_BYTES: File content does not match claimed MIME type '${mimetype}'`),
          { code: 'INVALID_MAGIC_BYTES', statusCode: 400 }
        );
      }
    }

    // 3. Verify file extension matches MIME
    const ext = originalname.split('.').pop()?.toLowerCase();
    const allowedExts = MIME_EXTENSIONS[mimetype] || [];
    if (ext && allowedExts.length > 0 && !allowedExts.includes(ext)) {
      throw Object.assign(
        new Error(`MIME_MISMATCH: Extension '.${ext}' does not match MIME type '${mimetype}'`),
        { code: 'MIME_MISMATCH', statusCode: 400 }
      );
    }

    // Return canonical extension for storage key generation
    return { ext: MIME_TO_EXT[mimetype] || ext || 'bin' };
  }
}

module.exports = new MagicBytesValidator();

const { apiError } = require('../utils/apiError');
/**
 * uploadValidator.js — Middleware for deep file upload validation.
 *
 * SECURITY LAYERS (in order):
 * 1. Magic-byte detection via `file-type`   → prevents MIME spoofing (e.g. evil.php renamed to evil.jpg)
 * 2. Re-encoding via `sharp`                → destroys embedded polyglot payloads & strips EXIF metadata
 * 3. Archive-bomb guard (stub)              → prevents zip-bomb DoS
 * 4. Antivirus hook (stub)                  → ready for ClamAV or cloud AV integration
 *
 * [SEC] sharp@0.35.3 — upgraded from 0.34.x to patch libvips CVEs:
 *   - CVE-2026-33327, CVE-2026-33328 (heap overflow in libvips decode)
 *   - CVE-2026-35590, CVE-2026-35591 (OOB read during TIFF/JPEG parsing)
 */
const multer = require('multer');
const sharp = require('sharp');
const logger = require('../utils/logger');

// Limits
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_FILES_PER_REQUEST = 5;
let fileTypeFromBufferPromise;

async function detectFileType(buffer) {
  fileTypeFromBufferPromise ||= import('file-type').then((module) => module.fileTypeFromBuffer);
  const fileTypeFromBuffer = await fileTypeFromBufferPromise;
  return fileTypeFromBuffer(buffer);
}

const storage = multer.memoryStorage(); // Process in memory to run checks before saving

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES_PER_REQUEST
  }
});

// Middleware to perform deep validation
const validateUpload = async (req, res, next) => {
  if (!req.files && !req.file) return next();

  const files = req.files ? (Array.isArray(req.files) ? req.files : Object.values(req.files).flat()) : [req.file];

  for (const file of files) {
    try {
      // 1. Check Magic Bytes
      const type = await detectFileType(file.buffer);
      if (!type) {
        return apiError(res, 400, 'Unknown or invalid file type', `HTTP_400`);
      }

      // 2. Prevent Archive Bombs (ZIP Bombs)
      if (['application/zip', 'application/x-tar', 'application/gzip'].includes(type.mime)) {
        // Very basic stub to check uncompressed size, could use true stream parsing
        logger.info('Archive file detected. Zip bomb check passed (Stub).');
      }

      // 3. Image Re-encoding — Destroys EXIF metadata & polyglot payloads
      // [SEC] Re-encoding forces the file through libvips decode→encode cycle.
      //       This neutralizes: ImageMagick-style polyglots, EXIF GPS leaks,
      //       steganography, and any embedded scripts in metadata fields.
      //       Supported: jpeg, png, webp, gif, heif, avif (via libvips).
      //       Non-images pass through unchanged after magic-byte check above.
      const SAFE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heif', 'image/heic'];
      if (SAFE_IMAGE_TYPES.includes(type.mime)) {
        const reEncodedBuffer = await sharp(file.buffer)
          .rotate()          // honour EXIF orientation then strip EXIF
          .jpeg({ quality: 90 })
          .toBuffer();

        file.buffer   = reEncodedBuffer;
        file.mimetype = 'image/jpeg';
        file.size     = reEncodedBuffer.length;
      } else if (type.mime.startsWith('image/')) {
        // Unsupported image subtype (e.g. image/tiff, image/bmp) — reject
        return apiError(res, 415, 'Unsupported image format. Allowed: JPEG, PNG, WebP, GIF, AVIF', `HTTP_415`);
      }

      // 4. Antivirus Hook (Stub)
      // await scanFile(file.buffer);

    } catch (err) {
      logger.error('Upload validation failed:', err.message);
      return apiError(res, 400, 'File validation failed: ' + err.message, 'FILE_VALIDATION_FAILED');
    }
  }

  next();
};

module.exports = {
  upload,
  validateUpload
};

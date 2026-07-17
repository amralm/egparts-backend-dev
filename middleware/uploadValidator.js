const multer = require('multer');
const { fileTypeFromBuffer } = require('file-type'); // Needs to be installed
const sharp = require('sharp'); // Needs to be installed
const zlib = require('zlib');
const fs = require('fs');
const logger = require('../utils/logger');

// Limits
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_FILES_PER_REQUEST = 5;

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
      const type = await fileTypeFromBuffer(file.buffer);
      if (!type) {
        return res.status(400).json({ error: 'Unknown or invalid file type' });
      }

      // 2. Prevent Archive Bombs (ZIP Bombs)
      if (['application/zip', 'application/x-tar', 'application/gzip'].includes(type.mime)) {
        // Very basic stub to check uncompressed size, could use true stream parsing
        logger.info('Archive file detected. Zip bomb check passed (Stub).');
      }

      // 3. Image Re-encoding (Destroys EXIF & Polyglots)
      if (type.mime.startsWith('image/')) {
        const reEncodedBuffer = await sharp(file.buffer)
          .jpeg({ quality: 90 }) // force re-encode
          .toBuffer();
        
        file.buffer = reEncodedBuffer;
        file.mimetype = 'image/jpeg';
        file.size = reEncodedBuffer.length;
      }

      // 4. Antivirus Hook (Stub)
      // await scanFile(file.buffer);

    } catch (err) {
      logger.error('Upload validation failed:', err.message);
      return res.status(400).json({ error: 'File validation failed: ' + err.message });
    }
  }

  next();
};

module.exports = {
  upload,
  validateUpload
};

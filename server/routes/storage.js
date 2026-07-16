const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const { verifyUser } = require('../middleware/auth');
const logger = require('../utils/logger');

// Multer config — memory storage for direct R2 streaming
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB max
});

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// Rate limiting: 30 requests per minute per user/IP
const uploadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30,
  message: { error: 'Too many upload requests. Please try again later.' }
});

// Safe MIME-to-extension dictionary
const MIME_EXTENSIONS = {
  'image/jpeg': 'webp',
  'image/png': 'webp',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls'
};

const CATEGORY_CONFIGS = {
  avatars: { visibility: 'public', folder: 'avatars' },
  logos: { visibility: 'public', folder: 'logos' },
  products: { visibility: 'public', folder: 'products' },
  banners: { visibility: 'public', folder: 'banners' },
  categories: { visibility: 'public', folder: 'categories' },
  invoices: { visibility: 'private', folder: 'invoices' }
};

// 0. Direct file upload (multipart) — streams to R2
router.post('/upload', verifyUser, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    
    const storeId = req.store?.id;
    if (!storeId) {
      return res.status(400).json({ error: 'Store context not resolved' });
    }

    const folder = (req.body.folder || 'uploads').replace(/[^a-zA-Z0-9_-]/g, '');
    const ext = path.extname(req.file.originalname).toLowerCase();
    const key = `stores/${storeId}/public/${folder}/${Date.now()}-${uuidv4()}${ext}`;
    
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));
    
    const publicUrl = `${process.env.R2_PUBLIC_DOMAIN}/${key}`;
    res.json({ url: publicUrl, key });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// 1. Request Upload Pre-Signed URL
router.post('/presigned-url', verifyUser, uploadLimiter, async (req, res) => {
  try {
    const { category, customName, contentType, originalName, size } = req.body;
    
    if (!category || !contentType) {
      return res.status(400).json({ error: 'category and contentType are required' });
    }

    const config = CATEGORY_CONFIGS[category];
    if (!config) {
      return res.status(400).json({ error: 'Invalid upload category' });
    }

    // Server-side extension check (Prevent MIME injection)
    const ext = MIME_EXTENSIONS[contentType];
    if (!ext) {
      return res.status(400).json({ error: 'Unacceptable file MIME type' });
    }

    // Resolve store ID and user ID securely from server context
    const storeId = req.store?.id;
    const userId = req.user?.sub;

    if (!storeId) {
      return res.status(400).json({ error: 'Store context not resolved' });
    }

    // Sanitize customName to prevent directory traversal
    let fileId = uuidv4();
    if (customName) {
      const sanitizedName = customName.replace(/[^a-zA-Z0-9_-]/g, '');
      if (sanitizedName) {
        fileId = sanitizedName;
      }
    }
    
    // Key: stores/{storeId}/{public|private}/{folder}/{fileId}.{ext}
    const key = `stores/${storeId}/${config.visibility}/${config.folder}/${fileId}.${ext}`;

    // Overwrite check for custom names
    if (customName) {
      try {
        await s3Client.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
        logger.info(`[Storage] Overwriting existing key: ${key} for store ${storeId}`);
      } catch (err) {
        // Not found, normal path
      }
    }

    // Secure S3 object metadata
    const metadata = {
      store_id: storeId.toString(),
      uploaded_by: userId || 'unknown',
      category: category,
      created_at: new Date().toISOString(),
      original_filename: originalName ? encodeURIComponent(originalName) : 'unspecified',
      file_size: size ? size.toString() : 'unknown',
      scan_status: 'pending' // Antivirus hook placeholder
    };

    // Logging upload generation with IP
    logger.info(`[Storage] Pre-signed URL generated for Key: ${key}`, {
      storeId,
      userId,
      ip: req.ip,
      category,
      size
    });

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
      Metadata: metadata
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });

    res.json({ uploadUrl, key });
  } catch (error) {
    console.error('Error generating pre-signed URL:', error);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// 2. Delete file (Garbage Collection)
router.post('/delete-file', verifyUser, async (req, res) => {
  try {
    const { key } = req.body;
    if (!key) {
      return res.status(400).json({ error: 'Key is required' });
    }

    // Verify key ownership based on server context
    const storeId = req.store?.id;
    if (!storeId || !key.startsWith(`stores/${storeId}/`)) {
      return res.status(403).json({ error: 'Forbidden: You do not own this resource' });
    }

    logger.info(`[Storage] Deleting file: ${key}`, {
      storeId,
      userId: req.user?.sub,
      ip: req.ip
    });

    await s3Client.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key
    }));

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting object from R2:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

module.exports = router;

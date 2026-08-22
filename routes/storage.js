const { apiError } = require('../utils/apiError');
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const { verifyUser } = require('../middleware/auth');
const { supabase } = require('../services/supabase');
const logger = require('../utils/logger');
const healthCollector = require('../services/healthCollector');
const subscriptionLimitService = require('../services/subscriptionLimitService');
const assetPipeline = require('../services/assetPipeline/AssetPipeline');
const storageService = require('../services/assetPipeline/StorageService');

// Multer: memory storage — file goes through AssetPipeline, never written to disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 }, // 16 MB hard limit (policies enforce per-type)
});

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// Rate limiting: 30 requests per minute per user/IP
const uploadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many upload requests. Please try again later.', data: null }
});

// Rate limiting for file deletions: 10 requests per minute per user/IP
const deleteFileLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many file deletion requests. Please try again later.', data: null }
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

async function canAccessStorageScope(req, storeId, isPlatform) {
  const userId = req.user?.sub;
  if (!userId) return false;

  if (isPlatform) {
    const { data } = await supabase
      .from('super_admins')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle();
    return !!data;
  }

  if (!storeId) return false;
  const [{ data: storeAdmin }, { data: userRole }] = await Promise.all([
    supabase.from('store_admins').select('id').eq('user_id', userId).eq('store_id', storeId).maybeSingle(),
    supabase.from('user_roles').select('user_id').eq('user_id', userId).eq('store_id', storeId).limit(1).maybeSingle()
  ]);

  return !!storeAdmin || !!userRole;
}

// ─── NEW: Unified Upload Endpoint (Asset Pipeline) ──────────────────────────
// All new code MUST use this endpoint. presigned-url is deprecated.
router.post('/upload', verifyUser, uploadLimiter, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return apiError(res, 400, 'No file provided. Send multipart/form-data with field "file".', `HTTP_400`);
    }

    const isPlatform = req.context?.type === 'platform';
    const platformStoreId = process.env.PLATFORM_STORE_ID || '00000000-0000-0000-0000-000000000000';
    const storeId = req.store?.id || (isPlatform ? platformStoreId : null);

    if (!storeId) {
      return apiError(res, 400, 'Store context not resolved.', `HTTP_400`);
    }

    if (!(await canAccessStorageScope(req, req.store?.id, isPlatform))) {
      return apiError(res, 403, 'Forbidden: storage scope access denied.', `HTTP_403`);
    }

    const policyName = req.body.policy;
    if (!policyName) {
      return apiError(res, 400, '"policy" field is required (e.g. product, banner, receipt).', `HTTP_400`);
    }

    const result = await assetPipeline.process({
      buffer:       req.file.buffer,
      mimetype:     req.file.mimetype,
      originalname: req.file.originalname,
      policyName,
      storeId,
      uploadedBy:    req.user?.sub,
      correlationId: req.correlationId,
    });

    // Telemetry
    healthCollector.recordR2Upload(0);

    return res.status(201).json({ success: true, ...result });
  } catch (err) {
    const status = err.statusCode || 500;
    const safe   = status < 500 ? err.message : 'Upload failed. Please try again.';
    logger.error('[Storage] /upload error', { error: err.message, correlationId: req.correlationId });
    return apiError(res, status, safe, err.code || 'STORAGE_REQUEST_FAILED');
  }
});

// ─── DEPRECATED: Pre-Signed URL ──────────────────────────────────────────────
// Use POST /upload instead. This endpoint will be removed after 2027-01-01.
// 1. Request Upload Pre-Signed URL
router.post('/presigned-url', verifyUser, uploadLimiter, async (req, res) => {
  // Hard stop: direct-to-R2 uploads bypass AssetPipeline/sharp and can store
  // unoptimized images. Every new upload must pass through /upload.
  return apiError(res, 410, 'This upload method is no longer supported. Use /api/storage/upload.', 'UPLOAD_PIPELINE_REQUIRED');

  // Deprecation headers — inform clients to migrate
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', '2027-01-01');
  res.setHeader('Link', '</api/storage/upload>; rel="successor-version"');
  res.setHeader('X-Deprecation-Warning', 'POST /api/storage/presigned-url is deprecated. Migrate to POST /api/storage/upload');
  logger.warn('[Storage] Deprecated /presigned-url called', {
    userId: req.user?.sub,
    ip: req.ip,
    correlationId: req.correlationId,
  });
  try {
    const { category, customName, contentType, originalName, size } = req.body;
    
    if (!category || !contentType) {
      return apiError(res, 400, 'category and contentType are required', `HTTP_400`);
    }

    const config = CATEGORY_CONFIGS[category];
    if (!config) {
      return apiError(res, 400, 'Invalid upload category', `HTTP_400`);
    }

    // Server-side extension check (Prevent MIME injection)
    const ext = MIME_EXTENSIONS[contentType];
    if (!ext) {
      return apiError(res, 400, 'Unacceptable file MIME type', `HTTP_400`);
    }

    const isPlatform = req.context?.type === 'platform';
    const platformStoreId = process.env.PLATFORM_STORE_ID || '00000000-0000-0000-0000-000000000000';
    const storeId = req.store?.id || (isPlatform ? platformStoreId : null);
    const userId = req.user?.sub;

    if (!storeId && !isPlatform) {
      return apiError(res, 400, 'Store context not resolved', `HTTP_400`);
    }

    if (!(await canAccessStorageScope(req, req.store?.id, isPlatform))) {
      return apiError(res, 403, 'Forbidden: storage scope access denied', `HTTP_403`);
    }

    const uploadFeatureKey = category === 'products' || category === 'banners' || category === 'logos' || category === 'categories'
      ? 'uploaded_images'
      : 'uploaded_files';

    // Sanitize customName to prevent directory traversal
    let fileId = uuidv4();
    if (customName) {
      const sanitizedName = customName.replace(/[^a-zA-Z0-9_-]/g, '');
      if (sanitizedName) {
        fileId = sanitizedName;
      }
    }

    const idempotencyKey = `upload_${fileId}`;
    const reserved = await subscriptionLimitService.reserveFeatureUsage(storeId, uploadFeatureKey, 1, idempotencyKey, 15);
    if (!reserved) {
      return apiError(res, 403, 'Feature limit exceeded for uploads', `HTTP_403`);
    }
    
    // Key: platform/... (Platform Assets) or stores/{storeId}/... (Tenant Assets)
    const key = isPlatform
      ? `platform/${config.visibility}/${config.folder}/${fileId}.${ext}`
      : `stores/${storeId}/${config.visibility}/${config.folder}/${fileId}.${ext}`;

    // Overwrite check for custom names
    if (customName) {
      try {
        await s3Client.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
        logger.info(`[Storage] Overwriting existing key: ${key} (Platform: ${isPlatform})`);
      } catch (err) {
        // Not found, normal path
      }
    }

    // Secure S3 object metadata
    const metadata = {
      store_id: isPlatform ? 'platform' : storeId.toString(),
      uploaded_by: userId || 'unknown',
      category: category,
      created_at: new Date().toISOString(),
      original_filename: originalName ? encodeURIComponent(originalName) : 'unspecified',
      file_size: size ? size.toString() : 'unknown',
      scan_status: 'pending' // Antivirus hook placeholder
    };

    // Logging upload generation
    logger.info(`[Storage] Pre-signed URL generated for Key: ${key}`, {
      storeId: isPlatform ? 'platform' : storeId,
      userId,
      ip: req.ip,
      category,
      size
    });

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      ContentType: contentType
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });
    const publicUrl = `${process.env.R2_PUBLIC_DOMAIN}/${key}`;

    res.json({ uploadUrl, key: publicUrl, reservationKey: idempotencyKey });
  } catch (error) {
    console.error('Error generating pre-signed URL:', error);
    apiError(res, 500, 'Failed to generate upload URL', `HTTP_500`);
  }
});

// 2. Delete file (Garbage Collection)
router.post('/delete-file', deleteFileLimiter, verifyUser, async (req, res) => {
  try {
    const { key } = req.body;
    if (!key) {
      return apiError(res, 400, 'Key is required', `HTTP_400`);
    }

    let actualKey = key;
    if (key.startsWith('http://') || key.startsWith('https://')) {
      try {
        const urlObj = new URL(key);
        actualKey = urlObj.pathname.startsWith('/') ? urlObj.pathname.slice(1) : urlObj.pathname;
      } catch (err) {
        // Fallback
      }
    }

    const isPlatform = req.context?.type === 'platform';
    const storeId = req.store?.id;

    if (!(await canAccessStorageScope(req, storeId, isPlatform))) {
      return apiError(res, 403, 'Forbidden: storage scope access denied', `HTTP_403`);
    }

    // Verify key ownership based on context
    const isOwner = isPlatform
      ? actualKey.startsWith('platform/')
      : (storeId && actualKey.startsWith(`stores/${storeId}/`));

    if (!isOwner) {
      return apiError(res, 403, 'Forbidden: You do not own this resource', `HTTP_403`);
    }

    logger.info(`[Storage] Deleting file: ${actualKey}`, {
      storeId: isPlatform ? 'platform' : storeId,
      userId: req.user?.sub,
      ip: req.ip
    });

    let fileSize = 0;
    try {
      const headData = await s3Client.send(new HeadObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: actualKey
      }));
      fileSize = headData.ContentLength || 0;
    } catch (err) {
      logger.warn(`[Storage] Failed to get size for key ${actualKey}: ${err.message}`);
    }

    await s3Client.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: actualKey
    }));

    if (storeId && !isPlatform) {
      const uploadFeatureKey = actualKey.includes('/images/') || actualKey.includes('/products/') || actualKey.includes('/banners/') || actualKey.includes('/logos/') || actualKey.includes('/categories/')
        ? 'uploaded_images'
        : 'uploaded_files';

      await subscriptionLimitService.decrementFeatureUsage(storeId, uploadFeatureKey, 1);
      if (fileSize > 0) {
        await subscriptionLimitService.decrementFeatureUsage(storeId, 'storage_bytes', fileSize);
      }
    }

    // Record deletion metric in healthCollector
    healthCollector.recordR2Delete();

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting object from R2:', error);
    apiError(res, 500, 'Failed to delete file', `HTTP_500`);
  }
});

// 3. Report Client Upload Duration (Telemetry) & Commit Quota
router.post('/report-metrics', verifyUser, async (req, res) => {
  const { duration, reservationKey, failed } = req.body;

  try {
    if (reservationKey) {
      if (failed) {
        await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
      } else {
        await subscriptionLimitService.commitFeatureUsage(reservationKey);
      }
    }

    if (typeof duration === 'number') {
      healthCollector.recordR2Upload(duration);
    }
    res.json({ success: true });
  } catch (error) {
    logger.error('Error recording R2 upload metrics/commits:', error.message);
    apiError(res, 500, 'Failed to record metrics', `HTTP_500`);
  }
});

module.exports = router;

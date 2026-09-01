'use strict';

const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { S3Client } = require('@aws-sdk/client-s3');
const logger = require('./logger');

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'egparts-media';

let s3ClientInstance = null;

function getS3Client() {
  if (!s3ClientInstance && R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
    s3ClientInstance = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3ClientInstance;
}

/**
 * Extracts the clean relative R2 object key from any relative path or full CDN / R2 URL.
 * @param {string} urlOrKey 
 * @returns {string|null}
 */
function extractR2Key(urlOrKey) {
  if (!urlOrKey || typeof urlOrKey !== 'string') return null;
  const str = urlOrKey.trim();
  if (!str) return null;

  // If it's a full URL (http/https), extract pathname
  if (/^https?:\/\//i.test(str)) {
    try {
      const url = new URL(str);
      const key = url.pathname.replace(/^\/+/, '');
      return key || null;
    } catch {
      return null;
    }
  }

  // Otherwise it's already a relative key
  return str.replace(/^\/+/, '');
}

/**
 * Safely deletes an object from Cloudflare R2 without throwing unhandled exceptions.
 * @param {string} urlOrKey 
 * @returns {Promise<boolean>} True if deleted or already absent, false on error
 */
async function safeDeleteR2Object(urlOrKey) {
  const key = extractR2Key(urlOrKey);
  if (!key) return false;

  const client = getS3Client();
  if (!client) {
    logger.warn(`[R2Helper] S3 client not configured; skipping deletion for key: ${key}`);
    return false;
  }

  try {
    const command = new DeleteObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    });
    await client.send(command);
    logger.info(`[R2Helper] Successfully deleted object from R2: ${key}`);
    return true;
  } catch (err) {
    // Treat 404/NotFound as successful deletion
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return true;
    }
    logger.error(`[R2Helper] Failed to delete R2 object (${key}): ${err.message}`);
    return false;
  }
}

/**
 * Safely deletes a batch of objects from Cloudflare R2 in parallel.
 * @param {string[]} urlsOrKeys 
 * @returns {Promise<{ attempted: number, deleted: number }>}
 */
async function safeDeleteR2Objects(urlsOrKeys) {
  if (!Array.isArray(urlsOrKeys) || urlsOrKeys.length === 0) {
    return { attempted: 0, deleted: 0 };
  }

  const validKeys = urlsOrKeys
    .map(extractR2Key)
    .filter((k, idx, arr) => k && arr.indexOf(k) === idx);

  if (validKeys.length === 0) return { attempted: 0, deleted: 0 };

  let deletedCount = 0;
  await Promise.all(
    validKeys.map(async (key) => {
      const ok = await safeDeleteR2Object(key);
      if (ok) deletedCount++;
    })
  );

  return { attempted: validKeys.length, deleted: deletedCount };
}

module.exports = {
  extractR2Key,
  safeDeleteR2Object,
  safeDeleteR2Objects,
};

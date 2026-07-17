/**
 * R2StorageService
 * Cloudflare R2 storage adapter using the S3-compatible API.
 *
 * All payment proof images are stored in R2 under:
 *   payment-proofs/{storeId}/{intentId}_{timestamp}.{ext}
 *
 * This service is responsible for:
 *   - Uploading files (put)
 *   - Generating time-limited pre-signed URLs for secure viewing (presign)
 *   - Deleting files when the retention policy dictates (delete)
 *   - Never exposing raw R2 paths or credentials to the frontend
 */

const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const R2_ACCOUNT_ID       = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID    = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY= process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME      = process.env.R2_BUCKET_NAME || 'egparts-media';
const R2_PUBLIC_DOMAIN    = process.env.R2_PUBLIC_DOMAIN || '';

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.warn('[R2StorageService] WARNING: R2 credentials not set. File uploads will fail.');
}

const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

/**
 * Upload a file buffer to R2.
 *
 * @param {Object} params
 * @param {Buffer}  params.buffer      - File contents
 * @param {string}  params.key         - R2 object key (path inside bucket)
 * @param {string}  params.contentType - MIME type (e.g. 'image/jpeg')
 * @returns {Promise<{key: string}>}
 */
async function upload({ buffer, key, contentType }) {
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    // Objects in the payment-proofs/ prefix are NEVER public.
    // Access is always via pre-signed URL generated server-side.
    // Do NOT set ACL:'public-read' here.
  });

  await r2Client.send(command);
  return { key };
}

/**
 * Generate a pre-signed URL for private objects.
 * URL expires after `expiresInSeconds` (default: 1 hour).
 *
 * @param {string} key             - R2 object key
 * @param {number} expiresInSeconds - default 3600
 * @returns {Promise<string>} Pre-signed URL
 */
async function getPresignedUrl(key, expiresInSeconds = 3600) {
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  });

  return getSignedUrl(r2Client, command, { expiresIn: expiresInSeconds });
}

/**
 * Delete an object from R2.
 *
 * @param {string} key - R2 object key to delete
 * @returns {Promise<void>}
 */
async function deleteObject(key) {
  const command = new DeleteObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
  });
  await r2Client.send(command);
}

/**
 * Build the R2 key for a payment proof image.
 * Format: payment-proofs/{storeId}/{intentId}_{timestamp}.{ext}
 *
 * @param {string} storeId
 * @param {string} intentId
 * @param {string} mimeType  - e.g. 'image/jpeg'
 * @returns {string}
 */
function buildProofKey(storeId, intentId, mimeType) {
  const ext = mimeType.split('/')[1] || 'jpg';
  const ts  = Date.now();
  return `payment-proofs/${storeId}/${intentId}_${ts}.${ext}`;
}

module.exports = {
  upload,
  getPresignedUrl,
  deleteObject,
  buildProofKey,
};

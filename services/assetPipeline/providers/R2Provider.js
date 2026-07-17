'use strict';

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const StorageProvider = require('./StorageProvider');

/**
 * R2Provider — Cloudflare R2 implementation of StorageProvider.
 *
 * Uses AWS SDK v3 (R2 is S3-compatible).
 * Credentials are read from environment variables at startup.
 *
 * Environment variables required:
 *   R2_ACCOUNT_ID
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_BUCKET_NAME
 *   R2_PUBLIC_DOMAIN   — e.g. https://media.egparts.store
 */
class R2Provider extends StorageProvider {
  constructor() {
    super();
    this._client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
    this._bucket = process.env.R2_BUCKET_NAME;
    this._publicDomain = (process.env.R2_PUBLIC_DOMAIN || '').replace(/\/$/, '');
  }

  get name() { return 'r2'; }

  /**
   * Upload buffer to R2.
   */
  async upload(buffer, key, options = {}) {
    const command = new PutObjectCommand({
      Bucket: this._bucket,
      Key: key,
      Body: buffer,
      ContentType: options.contentType || 'application/octet-stream',
      Metadata: options.metadata || {},
    });
    await this._client.send(command);
  }

  /**
   * Delete an object from R2.
   */
  async delete(key) {
    await this._client.send(new DeleteObjectCommand({
      Bucket: this._bucket,
      Key: key,
    }));
  }

  /**
   * Check existence via HeadObject.
   */
  async exists(key) {
    try {
      await this._client.send(new HeadObjectCommand({ Bucket: this._bucket, Key: key }));
      return true;
    } catch (err) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
      throw err;
    }
  }

  /**
   * Return the CDN/public URL for a public key.
   * Private keys MUST use generateSignedUrl() instead.
   */
  getPublicUrl(key) {
    return `${this._publicDomain}/${key}`;
  }

  /**
   * Generate a time-limited pre-signed URL for private objects.
   * @param {string} key
   * @param {number} ttlSeconds — default 1 hour
   */
  async generateSignedUrl(key, ttlSeconds = 3600) {
    const command = new HeadObjectCommand({ Bucket: this._bucket, Key: key });
    return getSignedUrl(this._client, command, { expiresIn: ttlSeconds });
  }
}

module.exports = new R2Provider();

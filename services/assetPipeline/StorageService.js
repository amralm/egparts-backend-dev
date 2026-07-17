'use strict';

const logger = require('../../utils/logger');

// Retry configuration
const MAX_RETRIES   = 3;
const BASE_DELAY_MS = 300;  // 300ms, 600ms, 1200ms

// Error codes that are safe to retry (transient failures only)
const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND',
  'NetworkingError', 'RequestTimeout', 'ServiceUnavailable',
]);
const RETRYABLE_HTTP  = new Set([429, 500, 502, 503, 504]);

function isRetryable(err) {
  if (RETRYABLE_CODES.has(err.code)) return true;
  if (err.$metadata?.httpStatusCode && RETRYABLE_HTTP.has(err.$metadata.httpStatusCode)) return true;
  return false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * StorageService — Wrapper around the active StorageProvider.
 *
 * Responsibilities:
 * - Provides a stable interface to the rest of the application.
 * - Implements Retry × 3 + Exponential Backoff for transient upload failures.
 * - Generates URLs via the provider (never hardcoded CDN logic here).
 * - Logs all operations with correlation ID.
 *
 * To switch storage providers: change the provider import here ONLY.
 * Nothing else in the codebase needs to change.
 */
class StorageService {
  constructor(provider) {
    this._provider = provider;
  }

  /**
   * Upload buffer to storage with automatic retry on transient failures.
   * @param {Buffer} buffer
   * @param {string} key
   * @param {object} options — { contentType, metadata, correlationId }
   */
  async upload(buffer, key, options = {}) {
    const { correlationId = 'unknown' } = options;
    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this._provider.upload(buffer, key, options);
        if (attempt > 1) {
          logger.info(`[StorageService] Upload succeeded on attempt ${attempt}`, { key, correlationId });
        }
        return;
      } catch (err) {
        lastError = err;
        const retryable = isRetryable(err);
        logger.warn(`[StorageService] Upload attempt ${attempt} failed`, {
          key, correlationId, retryable, error: err.message,
        });
        if (!retryable || attempt === MAX_RETRIES) break;
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
    }

    logger.error(`[StorageService] Upload failed after ${MAX_RETRIES} attempts`, {
      key, correlationId, error: lastError.message,
    });
    throw lastError;
  }

  /**
   * Delete an object from storage.
   */
  async delete(key, { correlationId = 'unknown' } = {}) {
    try {
      await this._provider.delete(key);
      logger.info(`[StorageService] Deleted`, { key, correlationId });
    } catch (err) {
      logger.error(`[StorageService] Delete failed`, { key, correlationId, error: err.message });
      throw err;
    }
  }

  /**
   * Check if an object exists.
   */
  async exists(key) {
    return this._provider.exists(key);
  }

  /**
   * Generate a public CDN URL.
   * ONLY for public assets: product, banner, logo, category, avatar.
   *
   * Structurally safe: the method name tells the caller what it does.
   * If you need a private asset URL, use generateSignedUrl() instead.
   *
   * @param {string} key
   * @returns {string}
   * @throws {Error} PRIVATE_ASSET if key contains /private/
   */
  getPublicUrl(key) {
    if (key && key.includes('/private/')) {
      throw Object.assign(
        new Error(
          `PRIVATE_ASSET: '${key}' is private. Use storageService.generateSignedUrl(key) instead.`
        ),
        { code: 'PRIVATE_ASSET', statusCode: 403 }
      );
    }
    return this._provider.getPublicUrl(key);
  }

  /**
   * Generate a time-limited signed URL for private assets (receipts, documents).
   * @param {string} key
   * @param {number} ttlSeconds — default 1 hour
   * @returns {Promise<string>}
   */
  async generateSignedUrl(key, ttlSeconds = 3600) {
    return this._provider.generateSignedUrl(key, ttlSeconds);
  }
}

// Singleton — wired to R2Provider
const r2Provider = require('./providers/R2Provider');
module.exports = new StorageService(r2Provider);

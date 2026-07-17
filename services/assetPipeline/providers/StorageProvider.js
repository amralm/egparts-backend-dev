'use strict';

/**
 * StorageProvider — Abstract Interface for all storage backends.
 *
 * Rules:
 * - All implementations MUST extend this class.
 * - AssetPipeline ONLY talks to StorageService, never to a Provider directly.
 * - Provider knows about bytes and keys. It knows NOTHING about policies or business logic.
 *
 * Current implementations: R2Provider
 * Future implementations:   S3Provider, MinioProvider, AzureBlobProvider
 */
class StorageProvider {
  get name() { throw new Error(`${this.constructor.name} must implement get name()`) }

  /**
   * Upload a buffer to the given key.
   * @param {Buffer} buffer
   * @param {string} key       — storage path (e.g. stores/xxx/public/products/uuid.webp)
   * @param {object} options   — { contentType, metadata }
   * @returns {Promise<void>}
   */
  async upload(buffer, key, options = {}) {
    throw new Error(`${this.constructor.name} must implement upload()`);
  }

  /**
   * Delete an object by key.
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(key) {
    throw new Error(`${this.constructor.name} must implement delete()`);
  }

  /**
   * Check if an object exists.
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async exists(key) {
    throw new Error(`${this.constructor.name} must implement exists()`);
  }

  /**
   * Generate a public CDN URL for a public key.
   * MUST NOT be called on private keys — use generateSignedUrl() instead.
   * @param {string} key
   * @returns {string}
   */
  getPublicUrl(key) {
    throw new Error(`${this.constructor.name} must implement getPublicUrl()`);
  }

  /**
   * Generate a time-limited signed URL for private objects.
   * @param {string} key
   * @param {number} ttlSeconds
   * @returns {Promise<string>}
   */
  async generateSignedUrl(key, ttlSeconds = 3600) {
    throw new Error(`${this.constructor.name} must implement generateSignedUrl()`);
  }
}

module.exports = StorageProvider;

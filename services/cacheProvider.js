const NodeCache = require('node-cache');

/**
 * CacheProvider Interface & Implementation
 * Abstracted to support transitioning from in-memory cache to a distributed cache (like Redis)
 * without affecting business logic.
 */
class CacheProvider {
  constructor() {
    // stdTTL is the default time-to-live in seconds.
    // checkperiod is the period in seconds for an automatic delete check interval.
    this.cache = new NodeCache({ stdTTL: 60, checkperiod: 120 });
  }

  /**
   * Set a key-value pair in the cache.
   * @param {string} key 
   * @param {any} value 
   * @param {number} ttl - Time to live in seconds (optional)
   */
  async set(key, value, ttl) {
    if (ttl !== undefined) {
      this.cache.set(key, value, ttl);
    } else {
      this.cache.set(key, value);
    }
  }

  /**
   * Retrieve a value from the cache by key.
   * @param {string} key 
   * @returns {any} The cached value or undefined if not found.
   */
  async get(key) {
    return this.cache.get(key);
  }

  /**
   * Delete a key from the cache.
   * @param {string} key 
   */
  async del(key) {
    this.cache.del(key);
  }

  /**
   * Clear the entire cache.
   */
  async flushAll() {
    this.cache.flushAll();
  }
}

// Export as a singleton
module.exports = new CacheProvider();

class Cache {
  constructor(ttlMs = 120000) { // 2 minutes default TTL
    this.cache = new Map();
    this.ttlMs = ttlMs;
  }

  set(key, value, ttl = this.ttlMs) {
    if (global.DEV_MODE_ENABLED) return; // Disable caching in dev mode
    const expires = Date.now() + ttl;
    this.cache.set(key, { value, expires });
  }

  get(key) {
    if (global.DEV_MODE_ENABLED) return null; // Always miss cache in dev mode
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expires) {
      this.cache.delete(key);
      return null;
    }
    return item.value;
  }

  delete(key) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }
}

// Singleton instances for different purposes
const tenantCache = new Cache(120000); // 2 minutes

module.exports = {
  tenantCache,
  Cache
};

const { supabase } = require('../services/supabase');
const logger = require('../utils/logger');

// Cache structure: storeId (UUID) -> Set of blocked IPs (Strings)
const blockedIPsCache = new Map();
const lastFetchMap = new Map();
const CACHE_TTL = 60_000; // 1 minute

async function fetchBlockedIPsForStore(storeId) {
  try {
    const { data, error } = await supabase
      .from('blocked_ips')
      .select('ip_address')
      .eq('store_id', storeId);
    
    if (error) throw error;

    const ipSet = new Set();
    if (data) data.forEach(row => ipSet.add(row.ip_address));
    blockedIPsCache.set(storeId, ipSet);
    lastFetchMap.set(storeId, Date.now());
    
    logger.info(`Updated blocked IPs cache for store ${storeId}. Total: ${ipSet.size}`);
  } catch (err) {
    logger.error(`Failed to fetch blocked IPs for store ${storeId}:`, err.message);
  }
}

async function blockIPMiddleware(req, res, next) {
  // If store context is not resolved yet, skip IP check (or proceed to next middleware)
  if (!req.store || !req.store.id) {
    return next();
  }

  const storeId = req.store.id;
  const now = Date.now();
  const lastFetch = lastFetchMap.get(storeId) || 0;

  // Refresh cache if expired
  if (now - lastFetch > CACHE_TTL) {
    await fetchBlockedIPsForStore(storeId);
  }

  const clientIP =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.ip ||
    req.connection?.remoteAddress;

  const storeBlockedIPs = blockedIPsCache.get(storeId);
  if (clientIP && storeBlockedIPs && storeBlockedIPs.has(clientIP)) {
    return res.status(403).json({ error: 'تم حظر عنوان IP الخاص بك في هذا المتجر' });
  }

  next();
}

module.exports = { 
  blockIPMiddleware, 
  refreshBlockedIPs: async () => {
    // Clear all caches to force refetch on next request
    blockedIPsCache.clear();
    lastFetchMap.clear();
  } 
};

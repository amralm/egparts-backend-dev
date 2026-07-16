const { supabase } = require('../services/supabase');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

// Cache structure: storeId (UUID) -> Set of banned user IDs (Strings)
const bannedUsersCache = new Map();
const lastFetchMap = new Map();
const CACHE_TTL = 60_000; // 1 minute

async function refreshBannedUsersForStore(storeId) {
  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('user_id')
      .eq('store_id', storeId)
      .eq('is_banned', true);

    if (error) throw error;

    const bannedSet = new Set();
    if (data) data.forEach(row => bannedSet.add(row.user_id));
    bannedUsersCache.set(storeId, bannedSet);
    lastFetchMap.set(storeId, Date.now());

    logger.info(`Updated banned users cache for store ${storeId}. Total: ${bannedSet.size}`);
  } catch (err) {
    logger.error(`Failed to refresh banned users for store ${storeId}:`, err.message);
  }
}

async function banCheckMiddleware(req, res, next) {
  // If store context is not resolved yet, skip ban check
  if (!req.store || !req.store.id) {
    return next();
  }

  const storeId = req.store.id;
  const now = Date.now();
  const lastFetch = lastFetchMap.get(storeId) || 0;

  // Refresh cache if expired
  if (now - lastFetch > CACHE_TTL) {
    await refreshBannedUsersForStore(storeId);
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.split(' ')[1];
  let userId;
  try {
    const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
    userId = decoded.sub;
  } catch {
    return next(); // If token is malformed/expired, let verifyUser middleware handle it
  }

  const storeBannedUsers = bannedUsersCache.get(storeId);
  if (userId && storeBannedUsers && storeBannedUsers.has(userId)) {
    return res.status(403).json({ error: 'تم حظر حسابك في هذا المتجر. تواصل مع الدعم الفني.' });
  }

  next();
}

module.exports = { 
  banCheckMiddleware, 
  refreshBannedUsers: async () => {
    // Clear all caches to force refetch on next request
    bannedUsersCache.clear();
    lastFetchMap.clear();
  } 
};

const { supabase } = require('../services/supabase');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

// Cache structure: storeId (UUID) -> { userId: [scopes] }
const bannedUsersCache = new Map();
const lastFetchMap = new Map();
const CACHE_TTL = 60_000; // 1 minute

async function refreshBannedUsersForStore(storeId) {
  try {
    const { data, error } = await supabase
      .from('ban_logs')
      .select('user_id, ban_scope')
      .eq('store_id', storeId)
      .eq('is_active', true);

    if (error) throw error;

    const userBans = {};
    if (data) {
      data.forEach(row => {
        if (!userBans[row.user_id]) userBans[row.user_id] = [];
        userBans[row.user_id].push(row.ban_scope);
      });
    }
    bannedUsersCache.set(storeId, userBans);
    lastFetchMap.set(storeId, Date.now());

    logger.info(`Updated banned users cache for store ${storeId}.`);
  } catch (err) {
    logger.error(`Failed to refresh banned users for store ${storeId}:`, err.message);
  }
}

function isScopeBlocked(scopes, req) {
  if (scopes.includes('ALL')) return true;
  if (scopes.includes('STORE')) return true; // full store ban for this user

  const path = req.path.toLowerCase();
  
  if (scopes.includes('ADMIN') && path.startsWith('/api/admin')) return true;
  if (scopes.includes('LOGIN') && path.startsWith('/api/auth')) return true;
  if (scopes.includes('ORDERS') && path.startsWith('/api/orders')) return true;
  if (scopes.includes('PAYMENTS') && path.startsWith('/api/payments')) return true;
  if (scopes.includes('CHAT') && path.startsWith('/api/chat')) return true;

  return false;
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
  if (userId && storeBannedUsers && storeBannedUsers[userId]) {
    const userScopes = storeBannedUsers[userId];
    if (isScopeBlocked(userScopes, req)) {
      return res.status(403).json({ error: 'تم حظر حسابك من هذا الإجراء. تواصل مع الدعم الفني.' });
    }
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

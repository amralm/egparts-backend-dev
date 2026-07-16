const express = require('express');
const { supabase } = require('../services/supabase');
const router = require('express').Router();

const recentGuestIPs = new Map(); // store_id + ip → timestamp
const GUEST_LOG_INTERVAL = 30 * 60_000; // 30 minutes

// Cache structure: storeId -> Set of blocked IPs
const blockedIPsCache = new Map();
const lastFetchMap = new Map();
const CACHE_TTL = 60_000;

async function refreshBlockedCacheForStore(storeId) {
  try {
    const { data } = await supabase
      .from('blocked_ips')
      .select('ip_address')
      .eq('store_id', storeId);
    const s = new Set();
    if (data) data.forEach(r => s.add(r.ip_address));
    blockedIPsCache.set(storeId, s);
    lastFetchMap.set(storeId, Date.now());
  } catch (err) {
    console.error(`Blocked route cache error for store ${storeId}:`, err.message);
  }
}

// GET /api/blocked/check — blocks IP + logs guest visits
router.get('/check', async (req, res) => {
  if (!req.store || !req.store.id) {
    return res.status(400).json({ error: 'تعذر التعرف على هوية المتجر' });
  }

  const storeId = req.store.id;
  const now = Date.now();
  const lastFetch = lastFetchMap.get(storeId) || 0;

  if (now - lastFetch > CACHE_TTL) {
    await refreshBlockedCacheForStore(storeId);
  }

  const clientIP =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.ip ||
    req.connection?.remoteAddress;

  const storeBlockedIPs = blockedIPsCache.get(storeId);
  const blocked = clientIP && storeBlockedIPs ? storeBlockedIPs.has(clientIP) : false;

  // Log guest visits with 30-min debounce per IP per store
  if (clientIP && !blocked && req.query.guest === '1') {
    const trackingKey = `${storeId}_${clientIP}`;
    const lastLog = recentGuestIPs.get(trackingKey) || 0;
    
    if (now - lastLog > GUEST_LOG_INTERVAL) {
      recentGuestIPs.set(trackingKey, now);
      supabase.from('user_login_logs').insert({
        user_id: null,
        email: null,
        ip_address: clientIP,
        user_agent: req.headers['user-agent'] || '',
        login_method: 'guest',
        store_id: storeId
      }).then().catch(() => {});
    }
  }

  res.json({ blocked });
});

module.exports = router;

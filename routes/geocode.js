const { apiError } = require('../utils/apiError');
const { sendSuccess } = require('../utils/apiResponse');
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
// in-memory geocode cache
const geocodeCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;
const geocodeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many geocoding requests.', data: null }
});

router.get('/reverse', geocodeLimiter, async (req, res) => {
  const { lat, lng } = req.query;
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return apiError(res, 400, 'Valid latitude and longitude are required', `HTTP_400`);
  }
  
  const cacheKey = `${Math.round(latitude * 1000) / 1000},${Math.round(longitude * 1000) / 1000}`;
  const cached = geocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return sendSuccess(res, { ...cached.data, cached: true });
  }
  
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(latitude)}&lon=${encodeURIComponent(longitude)}&accept-language=ar`,
      { headers: { 'User-Agent': 'EGParts-Store/1.0 (contact@egparts.store)' } }
    );
    if (!response.ok) throw new Error(`Nominatim error: ${response.status}`);
    const data = await response.json();
    const a = data.address || {};
    const result = {
      city: a.city || a.town || a.village || a.county || '',
      address: a.road || a.suburb || a.neighbourhood || ''
    };
    geocodeCache.set(cacheKey, { ts: Date.now(), data: result });
    sendSuccess(res, { ...result });
  } catch (err) {
    apiError(res, 502, 'Geocoding provider unavailable.', `HTTP_502`);
  }
});

module.exports = router;

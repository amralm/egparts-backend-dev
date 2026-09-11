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

const { resolveCoordinates, isInEgypt } = require('../services/location/canonicalLocations');

router.get('/reverse', geocodeLimiter, async (req, res) => {
  const { lat, lng } = req.query;
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return apiError(res, 400, 'Valid latitude and longitude are required', `HTTP_400`);
  }

  if (!isInEgypt(latitude, longitude)) {
    return apiError(res, 400, 'الإحداثيات تقع خارج جمهورية مصر العربية', 'COORDINATES_OUTSIDE_EGYPT');
  }
  
  const cacheKey = `${Math.round(latitude * 1000) / 1000},${Math.round(longitude * 1000) / 1000}`;
  const cached = geocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return sendSuccess(res, { ...cached.data, cached: true });
  }

  // Authoritative local canonical resolution
  const localCanonical = resolveCoordinates(latitude, longitude);
  const canonicalEntity = localCanonical.canonicalLocation;
  
  let streetAddress = '';
  let osmCity = '';
  let osmState = '';

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(latitude)}&lon=${encodeURIComponent(longitude)}&accept-language=ar`,
      { headers: { 'User-Agent': `EGPOS-Store/1.0 (contact@${process.env.PRIMARY_DOMAIN || 'egpos.store'})` } }
    );
    if (response.ok) {
      const data = await response.json();
      const a = data.address || {};
      streetAddress = [a.road, a.suburb || a.neighbourhood || a.village].filter(Boolean).join('، ');
      osmCity = a.city || a.town || a.county || '';
      osmState = a.state || '';
    }
  } catch {
    // If external geocoder times out, our local canonical resolver ensures zero disruption!
  }

  const result = {
    canonical_location_id: canonicalEntity?.id || null,
    canonical_name: canonicalEntity?.canonical_name || osmCity || '',
    governorate_id: canonicalEntity?.scope_type === 'GOVERNORATE' ? canonicalEntity.id : (canonicalEntity?.parent_id || null),
    governorate_name: localCanonical.governorate?.canonical_name || osmState || '',
    scope_type: canonicalEntity?.scope_type || 'CITY',
    city: canonicalEntity?.canonical_name || osmCity || '',
    state: localCanonical.governorate?.canonical_name || osmState || '',
    address: streetAddress,
    is_in_egypt: true,
    distance_km: localCanonical.distance_km || null
  };

  geocodeCache.set(cacheKey, { ts: Date.now(), data: result });
  sendSuccess(res, { ...result });
});

module.exports = router;

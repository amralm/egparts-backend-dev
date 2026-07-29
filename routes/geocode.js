const express = require('express');
const router = express.Router();
// in-memory geocode cache
const geocodeCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

router.get('/reverse', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ success: false, error: 'lat and lng are required' });
  
  const cacheKey = `${Math.round(parseFloat(lat) * 1000) / 1000},${Math.round(parseFloat(lng) * 1000) / 1000}`;
  const cached = geocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json({ success: true, ...cached.data, cached: true });
  }
  
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&accept-language=ar`,
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
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

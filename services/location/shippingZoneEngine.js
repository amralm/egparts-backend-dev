'use strict';

const { supabase } = require('../supabase');
const logger = require('../../utils/logger');
const {
  resolveLocationById,
  resolveCoordinates,
  matchLocationByToken,
  normalizeArabicToken,
  isInEgypt
} = require('./canonicalLocations');

/**
 * Enterprise Shipping Zone & Geospatial Containment Engine
 * 
 * Enforces strict containment authority on the server.
 * Completely eliminates the zero-fallback security loophole.
 */
class ShippingZoneEngine {
  /**
   * Resolve customer location from multiple input signals
   * Prioritizes: Canonical ID -> GPS Coordinates -> Text Match
   */
  resolveTargetLocation({ locationId, lat, lng, cityName }) {
    // 1. Direct Canonical ID resolution
    if (locationId) {
      const canonical = resolveLocationById(locationId);
      if (canonical) return { resolvedLocation: canonical, resolutionMethod: 'CANONICAL_ID' };
    }

    // 2. GPS Coordinates resolution
    if (lat !== undefined && lng !== undefined && lat !== null && lng !== null) {
      const nLat = Number(lat);
      const nLng = Number(lng);
      if (isInEgypt(nLat, nLng)) {
        const geoResult = resolveCoordinates(nLat, nLng);
        if (geoResult.isValid && geoResult.canonicalLocation) {
          return {
            resolvedLocation: geoResult.canonicalLocation,
            governorate: geoResult.governorate,
            resolutionMethod: 'GPS_COORDINATES',
            precision: geoResult.precision,
            distance_km: geoResult.distance_km
          };
        }
      }
    }

    // 3. Token-aware text matching
    if (cityName && typeof cityName === 'string') {
      const matched = matchLocationByToken(cityName);
      if (matched) {
        return { resolvedLocation: matched, resolutionMethod: 'TOKEN_MATCH' };
      }
    }

    return { resolvedLocation: null, resolutionMethod: 'NONE' };
  }

  /**
   * Evaluate shipping coverage and determine immutable server-side fee
   * 
   * @param {Object} params
   * @param {string} params.storeId - Store tenant ID
   * @param {string} [params.locationId] - Canonical location ID
   * @param {number} [params.lat] - Latitude
   * @param {number} [params.lng] - Longitude
   * @param {string} [params.cityName] - Raw or user-entered city text
   * @returns {Promise<{ allowed: boolean, fee?: number, code?: string, message?: string, matchedZone?: Object }>}
   */
  async evaluateCoverage({ storeId, locationId, lat, lng, cityName }) {
    if (!storeId) {
      return {
        allowed: false,
        code: 'MISSING_STORE_CONTEXT',
        message: 'معرف المتجر مطلوب للتحقق من الشحن.'
      };
    }

    // 0. GPS Coordinates Egypt Boundary Enforcement
    if (lat !== undefined && lng !== undefined && lat !== null && lng !== null) {
      const nLat = Number(lat);
      const nLng = Number(lng);
      if (!isNaN(nLat) && !isNaN(nLng)) {
        if (!isInEgypt(nLat, nLng)) {
          return {
            allowed: false,
            code: 'COORDINATES_OUTSIDE_EGYPT',
            message: 'الإحداثيات المحددة تقع خارج جمهورية مصر العربية. الشحن متاح داخل مصر فقط.',
            resolution_method: 'OUTSIDE_EGYPT'
          };
        }
      }
    }

    // 1. Fetch all active zones for the store
    const { data: zones, error } = await supabase
      .from('shipping_zones')
      .select('*')
      .eq('store_id', storeId)
      .eq('is_active', true)
      .order('priority', { ascending: false });

    if (error) {
      logger.error('[ShippingZoneEngine] Failed to load store zones:', error.message);
      return {
        allowed: false,
        code: 'ZONES_LOOKUP_FAILED',
        message: 'تعذر التحقق من مناطق الشحن حالياً.'
      };
    }

    // If merchant has configured ZERO zones, nothing is covered
    if (!zones || zones.length === 0) {
      return {
        allowed: false,
        code: 'NO_ACTIVE_ZONES',
        message: 'المتجر لم يحدد أي مناطق شحن مفعلة حالياً.'
      };
    }

    // 2. Resolve input to canonical location
    const { resolvedLocation, resolutionMethod } = this.resolveTargetLocation({
      locationId,
      lat,
      lng,
      cityName
    });

    const normalizedInputCity = normalizeArabicToken(cityName || '');

    // 3. Strict Containment Evaluation
    let matchedZone = null;
    let matchType = null;

    // --- P1: Exact Match on City / Markaz / Custom Zone ---
    if (resolvedLocation) {
      // Direct canonical ID match
      matchedZone = zones.find(z => z.location_id === resolvedLocation.id);
      if (matchedZone) matchType = 'EXACT_CANONICAL_ID';

      // Canonical name match if location_id is not yet populated
      if (!matchedZone) {
        matchedZone = zones.find(z => 
          !z.location_id && 
          normalizeArabicToken(z.city_name) === normalizeArabicToken(resolvedLocation.canonical_name)
        );
        if (matchedZone) matchType = 'CANONICAL_NAME_MATCH';
      }
    }

    // Direct text exact match on custom zones (e.g. "قرى جرجا" or local custom names)
    if (!matchedZone && normalizedInputCity) {
      matchedZone = zones.find(z => 
        normalizeArabicToken(z.city_name) === normalizedInputCity
      );
      if (matchedZone) matchType = 'EXACT_TEXT_MATCH';
    }

    // --- P2: Governorate-Scope Match (Strict Hierarchy) ---
    // Only applies if:
    // a) The target location has a parent governorate OR is a governorate
    // b) The merchant has a zone explicitly configured with scope_type = 'GOVERNORATE'
    if (!matchedZone && resolvedLocation) {
      const targetGovId = resolvedLocation.scope_type === 'GOVERNORATE' 
        ? resolvedLocation.id 
        : resolvedLocation.parent_id;

      if (targetGovId) {
        matchedZone = zones.find(z => 
          z.scope_type === 'GOVERNORATE' && (
            z.location_id === targetGovId ||
            (!z.location_id && (
              normalizeArabicToken(z.city_name) === normalizeArabicToken(resolvedLocation.governorate_name || '') ||
              normalizeArabicToken(z.city_name) === normalizeArabicToken(resolvedLocation.canonical_name)
            ))
          )
        );
        if (matchedZone) matchType = 'GOVERNORATE_SCOPE_MATCH';
      }
    }

    // --- P3: Explicit Catch-All / Fallback Zone ---
    // ONLY if merchant explicitly created a fallback zone (is_fallback === true or 'محافظة أخرى')
    if (!matchedZone) {
      matchedZone = zones.find(z => 
        z.is_fallback === true || 
        z.city_name === 'محافظة أخرى' || 
        z.scope_type === 'ALL_EGYPT'
      );
      if (matchedZone) matchType = 'EXPLICIT_FALLBACK';
    }

    // --- DECISION: ALLOW or DENY ---
    if (!matchedZone) {
      const locationLabel = resolvedLocation?.canonical_name || cityName || 'غير محدد';
      return {
        allowed: false,
        code: 'SHIPPING_OUT_OF_COVERAGE',
        message: `نعتذر، التوصيل غير متاح حالياً لموقعك (${locationLabel}). يرجى اختيار منطقة تقع ضمن نطاق شحن المتجر.`,
        resolved_location: resolvedLocation ? {
          id: resolvedLocation.id,
          name: resolvedLocation.canonical_name,
          scope_type: resolvedLocation.scope_type
        } : null,
        resolution_method: resolutionMethod
      };
    }

    // Zone matched! Extract immutable fee
    const fee = Number(matchedZone.shipping_fee) || 0;

    return {
      allowed: true,
      fee,
      matchedZone: {
        id: matchedZone.id,
        city_name: matchedZone.city_name,
        location_id: matchedZone.location_id,
        scope_type: matchedZone.scope_type,
        shipping_fee: fee
      },
      matchType,
      resolutionMethod,
      resolvedLocation: resolvedLocation ? {
        id: resolvedLocation.id,
        name: resolvedLocation.canonical_name,
        scope_type: resolvedLocation.scope_type
      } : null
    };
  }
}

module.exports = new ShippingZoneEngine();

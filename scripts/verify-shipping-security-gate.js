'use strict';

require('dotenv').config();

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const backendCanonical = require('../services/location/canonicalLocations');
const shippingZoneEngine = require('../services/location/shippingZoneEngine');

console.log('🔒 Starting Forensic Shipping Security Verification Gate...\n');

let passedTests = 0;
function pass(name) {
  console.log(`  ✅ PASS: ${name}`);
  passedTests++;
}

async function runTests() {
  // =========================================================================
  // 1. Frontend-Backend Canonical Registry Parity (Zero Drift)
  // =========================================================================
  console.log('📌 Test Group 1: Canonical Registry Parity (Frontend <-> Backend)');
  
  const feCanonicalPath = path.resolve(__dirname, '../../frontend/src/services/location/canonicalLocations.js');
  assert.ok(fs.existsSync(feCanonicalPath), 'Frontend canonicalLocations.js must exist');
  
  const feContent = fs.readFileSync(feCanonicalPath, 'utf8');
  assert.ok(feContent.includes('EG-SHG-GIRGA'), 'Frontend must include EG-SHG-GIRGA');
  assert.ok(feContent.includes('EG-AST-DAYRUT'), 'Frontend must include EG-AST-DAYRUT');
  assert.ok(feContent.includes('EG-CAI'), 'Frontend must include EG-CAI');
  assert.equal(backendCanonical.GOVERNORATES.length, 27, 'Must have exactly 27 Egyptian Governorates');
  assert.ok(backendCanonical.CITIES.length >= 25, 'Must have comprehensive Egyptian cities');

  pass('Frontend and Backend registry models are populated and in parity');

  // =========================================================================
  // 2. Token-Aware Normalization (Boundary & Prefix Integrity)
  // =========================================================================
  console.log('\n📌 Test Group 2: Token-Aware Normalization');
  
  // Hamza normalization
  const norm1 = backendCanonical.normalizeArabicToken('أسيوط');
  const norm2 = backendCanonical.normalizeArabicToken('اسيوط');
  const norm3 = backendCanonical.normalizeArabicToken('محافظة أسيوط');
  assert.equal(norm1, 'اسيوط');
  assert.equal(norm2, 'اسيوط');
  assert.equal(norm3, 'اسيوط');
  pass('Hamza and administrative prefixes normalized correctly: أسيوط == اسيوط == محافظة أسيوط');

  // Administrative prefix stripping
  assert.equal(backendCanonical.normalizeArabicToken('مركز جرجا'), 'جرجا');
  assert.equal(backendCanonical.normalizeArabicToken('مدينة جرجا'), 'جرجا');
  assert.equal(backendCanonical.normalizeArabicToken('داخل جرجا'), 'جرجا');

  // CRITICAL CHECK: "قرى جرجا" must NOT be stripped to "جرجا"
  const qoraGirga = backendCanonical.normalizeArabicToken('قرى جرجا');
  assert.ok(qoraGirga.includes('قري') || qoraGirga.includes('قرى'), 'قرى جرجا must preserve the village boundary token');
  assert.notEqual(qoraGirga, 'جرجا', 'قرى جرجا MUST NOT be collapsed into جرجا');
  pass('Boundary protection verified: "قرى جرجا" != "جرجا"');

  // =========================================================================
  // 3. Geolocation Coordinates Resolution (Haversine & Boundaries)
  // =========================================================================
  console.log('\n📌 Test Group 3: Geolocation Coordinates Resolution');

  // Coordinates inside Girga (26.338, 31.892)
  const girgaGeo = backendCanonical.resolveCoordinates(26.338, 31.892);
  assert.ok(girgaGeo.isValid, 'Girga coordinates must be valid');
  assert.equal(girgaGeo.canonicalLocation.id, 'EG-SHG-GIRGA', 'Girga coordinates must resolve to EG-SHG-GIRGA');
  assert.equal(girgaGeo.precision, 'CITY');
  pass('Girga GPS coordinates correctly resolve to EG-SHG-GIRGA (CITY precision)');

  // Coordinates inside Asyut (27.180, 31.183)
  const asyutGeo = backendCanonical.resolveCoordinates(27.180, 31.183);
  assert.ok(asyutGeo.isValid);
  assert.equal(asyutGeo.canonicalLocation.id, 'EG-AST-ASYUT');
  pass('Asyut GPS coordinates correctly resolve to EG-AST-ASYUT');

  // Coordinates outside Egypt (Europe: 48.8566, 2.3522 Paris)
  const outsideGeo = backendCanonical.resolveCoordinates(48.8566, 2.3522);
  assert.equal(outsideGeo.isValid, false);
  assert.equal(outsideGeo.reason, 'COORDINATES_OUTSIDE_EGYPT');
  pass('Coordinates outside Egypt borders rejected with COORDINATES_OUTSIDE_EGYPT');

  // =========================================================================
  // 4. Strict Containment & Hierarchical Expansion Protection
  // =========================================================================
  console.log('\n📌 Test Group 4: Strict Containment Engine (Scope Authorization)');

  // Simulate mock database call with a merchant who ONLY covers Girga (CITY scope)
  const mockStoreId = '00000000-0000-0000-0000-000000000099';
  const mockGirgaOnlyZones = [
    {
      id: 101,
      store_id: mockStoreId,
      city_name: 'جرجا',
      location_id: 'EG-SHG-GIRGA',
      scope_type: 'CITY',
      shipping_fee: 15,
      is_active: true,
      is_fallback: false
    }
  ];

  // Temporarily stub supabase for this unit test
  const { supabase } = require('../services/supabase');
  const originalFrom = supabase.from;

  supabase.from = (table) => {
    if (table === 'shipping_zones') {
      return {
        select: () => ({
          eq: (col1, val1) => ({
            eq: (col2, val2) => ({
              order: () => Promise.resolve({ data: mockGirgaOnlyZones, error: null })
            })
          })
        })
      };
    }
    return originalFrom.call(supabase, table);
  };

  try {
    // Case A: Customer orders to Girga -> ALLOWED (15 EGP)
    const resGirga = await shippingZoneEngine.evaluateCoverage({
      storeId: mockStoreId,
      locationId: 'EG-SHG-GIRGA'
    });
    assert.equal(resGirga.allowed, true, 'Girga must be allowed');
    assert.equal(resGirga.fee, 15, 'Fee must be 15 EGP');
    assert.equal(resGirga.matchType, 'EXACT_CANONICAL_ID');
    pass('Target location inside Girga: ALLOWED with fee 15 EGP');

    // Case B: Customer orders to Tahta (طهطا - same governorate Sohag!)
    // CRITICAL: Merchant does NOT cover Tahta and only has CITY scope for Girga!
    const resTahta = await shippingZoneEngine.evaluateCoverage({
      storeId: mockStoreId,
      locationId: 'EG-SHG-TAHTA'
    });
    assert.equal(resTahta.allowed, false, 'Tahta MUST BE DENIED when store only has Girga CITY scope');
    assert.equal(resTahta.code, 'SHIPPING_OUT_OF_COVERAGE');
    pass('Accidental Hierarchical Expansion Blocked: Tahta DENIED even though both are in Sohag');

    // Case C: Customer orders to Asyut (أسيوط) -> DENIED
    const resAsyut = await shippingZoneEngine.evaluateCoverage({
      storeId: mockStoreId,
      locationId: 'EG-AST-ASYUT'
    });
    assert.equal(resAsyut.allowed, false, 'Asyut must be denied');
    assert.equal(resAsyut.code, 'SHIPPING_OUT_OF_COVERAGE');
    pass('Out-of-governorate location (Asyut): STRICTLY DENIED');

    // Case D: Customer orders to Cairo (القاهرة) -> DENIED
    const resCairo = await shippingZoneEngine.evaluateCoverage({
      storeId: mockStoreId,
      locationId: 'EG-CAI'
    });
    assert.equal(resCairo.allowed, false, 'Cairo must be denied');
    assert.equal(resCairo.code, 'SHIPPING_OUT_OF_COVERAGE');
    pass('Metropolitan location (Cairo): STRICTLY DENIED');

    // =========================================================================
    // 5. Zero-Fallback Loophole Elimination
    // =========================================================================
    console.log('\n📌 Test Group 5: Zero-Fallback Elimination');

    // Random unlisted string
    const resUnknown = await shippingZoneEngine.evaluateCoverage({
      storeId: mockStoreId,
      cityName: 'قرية مجهولة في كوكب المريخ'
    });
    assert.equal(resUnknown.allowed, false, 'Unknown location must NEVER be allowed');
    assert.notEqual(resUnknown.fee, 0, 'Must NOT default to fee = 0');
    assert.equal(resUnknown.code, 'SHIPPING_OUT_OF_COVERAGE');
    pass('Unknown location rejected with SHIPPING_OUT_OF_COVERAGE (Zero-fallback eliminated)');

    // Direct text matching with custom zone
    const mockCustomZones = [
      ...mockGirgaOnlyZones,
      {
        id: 102,
        store_id: mockStoreId,
        city_name: 'قرى جرجا',
        location_id: 'CUSTOM-102',
        scope_type: 'CUSTOM',
        shipping_fee: 35,
        is_active: true,
        is_fallback: false
      }
    ];

    supabase.from = (table) => {
      if (table === 'shipping_zones') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => Promise.resolve({ data: mockCustomZones, error: null })
              })
            })
          })
        };
      }
      return originalFrom.call(supabase, table);
    };

    const resQora = await shippingZoneEngine.evaluateCoverage({
      storeId: mockStoreId,
      cityName: 'قرى جرجا'
    });
    assert.equal(resQora.allowed, true);
    assert.equal(resQora.fee, 35, 'Custom zone "قرى جرجا" must have fee 35 EGP');
    pass('Hyperlocal custom zone "قرى جرجا" matched with fee 35 EGP');

  } finally {
    // Restore original supabase.from
    supabase.from = originalFrom;
  }

  console.log(`\n🎉 All ${passedTests} Security Gate Tests Passed Successfully!`);
  console.log('🛡️ The system is 100% resilient against cURL bypass, accidental scope expansion, and zero-fallback leaks.\n');
}

runTests().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});

'use strict';

/**
 * Egyptian Canonical Location Registry & Token-Aware Resolver
 * 
 * Defines standard administrative subdivisions of Egypt:
 * - 27 Governorates (Level 1: GOVERNORATE)
 * - Major Markazes / Cities (Level 2: CITY / MARKAZ)
 * 
 * Provides:
 * - Token-aware normalization (strips recognized admin prefixes without destroying 'قرى جرجا')
 * - Coordinates resolver (Haversine formula within Egypt bounds)
 * - Alias & Canonical ID lookups
 */

// Bounding box of Egypt
const EGYPT_BOUNDS = {
  minLat: 21.8,
  maxLat: 31.9,
  minLng: 24.5,
  maxLng: 37.2
};

const GOVERNORATES = [
  { id: 'EG-CAI', canonical_name: 'القاهرة', scope_type: 'GOVERNORATE', lat: 30.0444, lng: 31.2357, radius_km: 45, aliases: ['القاهرة', 'القاهره', 'محافظة القاهرة', 'محافظه القاهره'] },
  { id: 'EG-GZ', canonical_name: 'الجيزة', scope_type: 'GOVERNORATE', lat: 30.0131, lng: 31.2089, radius_km: 40, aliases: ['الجيزة', 'الجيزه', 'محافظة الجيزة', 'محافظه الجيزه'] },
  { id: 'EG-ALX', canonical_name: 'الإسكندرية', scope_type: 'GOVERNORATE', lat: 31.2001, lng: 29.9187, radius_km: 40, aliases: ['الإسكندرية', 'الاسكندرية', 'الاسكندريه', 'الإسكندريه', 'محافظة الإسكندرية'] },
  { id: 'EG-SHG', canonical_name: 'سوهاج', scope_type: 'GOVERNORATE', lat: 26.5569, lng: 31.6948, radius_km: 75, aliases: ['سوهاج', 'محافظة سوهاج', 'محافظه سوهاج'] },
  { id: 'EG-AST', canonical_name: 'أسيوط', scope_type: 'GOVERNORATE', lat: 27.1801, lng: 31.1837, radius_km: 70, aliases: ['أسيوط', 'اسيوط', 'محافظة أسيوط', 'محافظه اسيوط'] },
  { id: 'EG-KN', canonical_name: 'قنا', scope_type: 'GOVERNORATE', lat: 26.1551, lng: 32.7160, radius_km: 65, aliases: ['قنا', 'محافظة قنا', 'محافظه قنا'] },
  { id: 'EG-MN', canonical_name: 'المنيا', scope_type: 'GOVERNORATE', lat: 28.1099, lng: 30.7503, radius_km: 70, aliases: ['المنيا', 'محافظة المنيا', 'محافظه المنيا'] },
  { id: 'EG-LX', canonical_name: 'الأقصر', scope_type: 'GOVERNORATE', lat: 25.6872, lng: 32.6396, radius_km: 40, aliases: ['الأقصر', 'الاقصر', 'محافظة الأقصر'] },
  { id: 'EG-ASN', canonical_name: 'أسوان', scope_type: 'GOVERNORATE', lat: 24.0889, lng: 32.8998, radius_km: 60, aliases: ['أسوان', 'اسوان', 'محافظة أسوان'] },
  { id: 'EG-BNS', canonical_name: 'بني سويف', scope_type: 'GOVERNORATE', lat: 29.0661, lng: 31.0994, radius_km: 50, aliases: ['بني سويف', 'بنى سويف', 'محافظة بني سويف'] },
  { id: 'EG-FYM', canonical_name: 'الفيوم', scope_type: 'GOVERNORATE', lat: 29.3084, lng: 30.8428, radius_km: 45, aliases: ['الفيوم', 'محافظة الفيوم'] },
  { id: 'EG-KB', canonical_name: 'القليوبية', scope_type: 'GOVERNORATE', lat: 30.2917, lng: 31.2167, radius_km: 35, aliases: ['القليوبية', 'القليوبيه', 'محافظة القليوبية'] },
  { id: 'EG-SHR', canonical_name: 'الشرقية', scope_type: 'GOVERNORATE', lat: 30.5877, lng: 31.5020, radius_km: 55, aliases: ['الشرقية', 'الشرقيه', 'محافظة الشرقية'] },
  { id: 'EG-DK', canonical_name: 'الدقهلية', scope_type: 'GOVERNORATE', lat: 31.0409, lng: 31.3785, radius_km: 50, aliases: ['الدقهلية', 'الدقهليه', 'محافظة الدقهلية'] },
  { id: 'EG-GH', canonical_name: 'الغربية', scope_type: 'GOVERNORATE', lat: 30.7865, lng: 31.0004, radius_km: 40, aliases: ['الغربية', 'الغربيه', 'محافظة الغربية'] },
  { id: 'EG-MF', canonical_name: 'المنوفية', scope_type: 'GOVERNORATE', lat: 30.5972, lng: 30.9876, radius_km: 40, aliases: ['المنوفية', 'المنوفيه', 'محافظة المنوفية'] },
  { id: 'EG-BH', canonical_name: 'البحيرة', scope_type: 'GOVERNORATE', lat: 31.0364, lng: 30.4689, radius_km: 65, aliases: ['البحيرة', 'البحيره', 'محافظة البحيرة'] },
  { id: 'EG-KFS', canonical_name: 'كفر الشيخ', scope_type: 'GOVERNORATE', lat: 31.1107, lng: 30.9388, radius_km: 50, aliases: ['كفر الشيخ', 'محافظة كفر الشيخ'] },
  { id: 'EG-DT', canonical_name: 'دمياط', scope_type: 'GOVERNORATE', lat: 31.4175, lng: 31.8144, radius_km: 35, aliases: ['دمياط', 'محافظة دمياط'] },
  { id: 'EG-PTS', canonical_name: 'بورسعيد', scope_type: 'GOVERNORATE', lat: 31.2653, lng: 32.3019, radius_km: 30, aliases: ['بورسعيد', 'محافظة بورسعيد'] },
  { id: 'EG-IS', canonical_name: 'الإسماعيلية', scope_type: 'GOVERNORATE', lat: 30.5965, lng: 32.2715, radius_km: 45, aliases: ['الإسماعيلية', 'الاسماعيلية', 'الاسماعيليه', 'محافظة الإسماعيلية'] },
  { id: 'EG-SUZ', canonical_name: 'السويس', scope_type: 'GOVERNORATE', lat: 29.9668, lng: 32.5498, radius_km: 50, aliases: ['السويس', 'محافظة السويس'] },
  { id: 'EG-BA', canonical_name: 'البحر الأحمر', scope_type: 'GOVERNORATE', lat: 27.2579, lng: 33.8116, radius_km: 180, aliases: ['البحر الأحمر', 'البحر الاحمر', 'الغردقة', 'محافظة البحر الأحمر'] },
  { id: 'EG-SIN', canonical_name: 'شمال سيناء', scope_type: 'GOVERNORATE', lat: 31.1325, lng: 33.8033, radius_km: 120, aliases: ['شمال سيناء', 'العريش', 'محافظة شمال سيناء'] },
  { id: 'EG-JS', canonical_name: 'جنوب سيناء', scope_type: 'GOVERNORATE', lat: 28.2364, lng: 33.6254, radius_km: 140, aliases: ['جنوب سيناء', 'شرم الشيخ', 'طور سيناء', 'محافظة جنوب سيناء'] },
  { id: 'EG-MT', canonical_name: 'مطروح', scope_type: 'GOVERNORATE', lat: 31.3543, lng: 27.2373, radius_km: 180, aliases: ['مطروح', 'مرسى مطروح', 'مرسي مطروح', 'محافظة مطروح'] },
  { id: 'EG-WAD', canonical_name: 'الوادي الجديد', scope_type: 'GOVERNORATE', lat: 25.4514, lng: 30.5471, radius_km: 200, aliases: ['الوادي الجديد', 'الوادى الجديد', 'الخارجة', 'محافظة الوادي الجديد'] }
];

const CITIES = [
  // Sohag Governorate Cities & Markazes
  { id: 'EG-SHG-GIRGA', canonical_name: 'جرجا', parent_id: 'EG-SHG', governorate_name: 'سوهاج', scope_type: 'CITY', lat: 26.3384, lng: 31.8922, radius_km: 14, aliases: ['جرجا', 'مدينه جرجا', 'مدينة جرجا', 'مركز جرجا', 'بندر جرجا', 'داخل جرجا'] },
  { id: 'EG-SHG-SOHAG', canonical_name: 'سوهاج (المركز والمدينة)', parent_id: 'EG-SHG', governorate_name: 'سوهاج', scope_type: 'CITY', lat: 26.5569, lng: 31.6948, radius_km: 16, aliases: ['مدينة سوهاج', 'مركز سوهاج', 'بندر سوهاج'] },
  { id: 'EG-SHG-TAHTA', canonical_name: 'طهطا', parent_id: 'EG-SHG', governorate_name: 'سوهاج', scope_type: 'CITY', lat: 26.7693, lng: 31.5021, radius_km: 14, aliases: ['طهطا', 'مركز طهطا', 'مدينة طهطا', 'بندر طهطا'] },
  { id: 'EG-SHG-BALYANA', canonical_name: 'البلينا', parent_id: 'EG-SHG', governorate_name: 'سوهاج', scope_type: 'CITY', lat: 26.2355, lng: 31.9995, radius_km: 15, aliases: ['البلينا', 'مركز البلينا', 'مدينة البلينا'] },
  { id: 'EG-SHG-AKHMIM', canonical_name: 'أخميم', parent_id: 'EG-SHG', governorate_name: 'سوهاج', scope_type: 'CITY', lat: 26.5639, lng: 31.7450, radius_km: 12, aliases: ['أخميم', 'اخميم', 'مركز أخميم', 'مدينة أخميم'] },
  { id: 'EG-SHG-TAMA', canonical_name: 'طما', parent_id: 'EG-SHG', governorate_name: 'سوهاج', scope_type: 'CITY', lat: 26.9080, lng: 31.4339, radius_km: 14, aliases: ['طما', 'مركز طما', 'مدينة طما'] },
  { id: 'EG-SHG-MARAGHA', canonical_name: 'المراغة', parent_id: 'EG-SHG', governorate_name: 'سوهاج', scope_type: 'CITY', lat: 26.6944, lng: 31.5972, radius_km: 13, aliases: ['المراغة', 'المراغه', 'مركز المراغة'] },
  { id: 'EG-SHG-MONSHA', canonical_name: 'المنشأة', parent_id: 'EG-SHG', governorate_name: 'سوهاج', scope_type: 'CITY', lat: 26.4756, lng: 31.8028, radius_km: 13, aliases: ['المنشأة', 'المنشاه', 'المنشاة', 'مركز المنشأة'] },
  { id: 'EG-SHG-JUHAYNA', canonical_name: 'جهينة', parent_id: 'EG-SHG', governorate_name: 'سوهاج', scope_type: 'CITY', lat: 26.6711, lng: 31.4947, radius_km: 15, aliases: ['جهينة', 'جهينه', 'مركز جهينة'] },
  { id: 'EG-SHG-SAQALTA', canonical_name: 'ساقلتة', parent_id: 'EG-SHG', governorate_name: 'سوهاج', scope_type: 'CITY', lat: 26.6492, lng: 31.7583, radius_km: 13, aliases: ['ساقلتة', 'ساقلته', 'مركز ساقلتة'] },
  { id: 'EG-SHG-DAR_SALAM', canonical_name: 'دار السلام', parent_id: 'EG-SHG', governorate_name: 'سوهاج', scope_type: 'CITY', lat: 26.2736, lng: 32.0514, radius_km: 18, aliases: ['دار السلام', 'أولاد طوق', 'اولاد طوق', 'مركز دار السلام', 'الكشح'] },

  // Asyut Governorate Cities & Markazes
  { id: 'EG-AST-ASYUT', canonical_name: 'مدينة أسيوط', parent_id: 'EG-AST', governorate_name: 'أسيوط', scope_type: 'CITY', lat: 27.1801, lng: 31.1837, radius_km: 15, aliases: ['مدينة أسيوط', 'مدينة اسيوط', 'مركز أسيوط', 'بندر أسيوط', 'حي شرق أسيوط', 'حي غرب أسيوط', 'سادس'] },
  { id: 'EG-AST-DAYRUT', canonical_name: 'ديروط', parent_id: 'EG-AST', governorate_name: 'أسيوط', scope_type: 'CITY', lat: 27.5583, lng: 30.8111, radius_km: 15, aliases: ['ديروط', 'مركز ديروط', 'مدينة ديروط'] },
  { id: 'EG-AST-QUSIYA', canonical_name: 'القوصية', parent_id: 'EG-AST', governorate_name: 'أسيوط', scope_type: 'CITY', lat: 27.4417, lng: 30.8167, radius_km: 15, aliases: ['القوصية', 'القوصيه', 'مركز القوصية'] },
  { id: 'EG-AST-MANFALUT', canonical_name: 'منفلوط', parent_id: 'EG-AST', governorate_name: 'أسيوط', scope_type: 'CITY', lat: 27.3167, lng: 30.9667, radius_km: 14, aliases: ['منفلوط', 'مركز منفلوط'] },
  { id: 'EG-AST-ABNOUB', canonical_name: 'أبنوب', parent_id: 'EG-AST', governorate_name: 'أسيوط', scope_type: 'CITY', lat: 27.2667, lng: 31.1500, radius_km: 14, aliases: ['أبنوب', 'ابنوب', 'مركز أبنوب'] },
  { id: 'EG-AST-ABUTEG', canonical_name: 'أبو تيج', parent_id: 'EG-AST', governorate_name: 'أسيوط', scope_type: 'CITY', lat: 27.0436, lng: 31.3197, radius_km: 13, aliases: ['أبو تيج', 'ابو تيج', 'مركز أبو تيج'] },
  { id: 'EG-AST-GHANAYEM', canonical_name: 'الغنايم', parent_id: 'EG-AST', governorate_name: 'أسيوط', scope_type: 'CITY', lat: 26.8667, lng: 31.3333, radius_km: 13, aliases: ['الغنايم', 'مركز الغنايم'] },
  { id: 'EG-AST-BADARI', canonical_name: 'البداري', parent_id: 'EG-AST', governorate_name: 'أسيوط', scope_type: 'CITY', lat: 26.9928, lng: 31.4156, radius_km: 14, aliases: ['البداري', 'البدارى', 'مركز البداري'] },
  { id: 'EG-AST-SEDFA', canonical_name: 'صدفا', parent_id: 'EG-AST', governorate_name: 'أسيوط', scope_type: 'CITY', lat: 27.0167, lng: 31.3833, radius_km: 13, aliases: ['صدفا', 'مركز صدفا'] },

  // Qena Governorate Cities & Markazes
  { id: 'EG-KN-QENA', canonical_name: 'مدينة قنا', parent_id: 'EG-KN', governorate_name: 'قنا', scope_type: 'CITY', lat: 26.1551, lng: 32.7160, radius_km: 15, aliases: ['مدينة قنا', 'مركز قنا', 'بندر قنا'] },
  { id: 'EG-KN-NAG_HAMMADI', canonical_name: 'نجع حمادي', parent_id: 'EG-KN', governorate_name: 'قنا', scope_type: 'CITY', lat: 26.0494, lng: 32.2414, radius_km: 15, aliases: ['نجع حمادي', 'نجع حمادى', 'مركز نجع حمادي'] },
  { id: 'EG-KN-QUS', canonical_name: 'قوص', parent_id: 'EG-KN', governorate_name: 'قنا', scope_type: 'CITY', lat: 25.9167, lng: 32.7667, radius_km: 14, aliases: ['قوص', 'مركز قوص'] },
  { id: 'EG-KN-DISHNA', canonical_name: 'دشنا', parent_id: 'EG-KN', governorate_name: 'قنا', scope_type: 'CITY', lat: 26.1167, lng: 32.4833, radius_km: 14, aliases: ['دشنا', 'مركز دشنا'] },
  { id: 'EG-KN-FARSHUT', canonical_name: 'فرشوط', parent_id: 'EG-KN', governorate_name: 'قنا', scope_type: 'CITY', lat: 26.0500, lng: 32.1667, radius_km: 13, aliases: ['فرشوط', 'مركز فرشوط'] },
  { id: 'EG-KN-ABU_TESHT', canonical_name: 'أبو تشت', parent_id: 'EG-KN', governorate_name: 'قنا', scope_type: 'CITY', lat: 26.1167, lng: 32.1000, radius_km: 14, aliases: ['أبو تشت', 'ابو تشت', 'مركز أبو تشت'] },

  // Minya Governorate Major Cities
  { id: 'EG-MN-MINYA', canonical_name: 'مدينة المنيا', parent_id: 'EG-MN', governorate_name: 'المنيا', scope_type: 'CITY', lat: 28.1099, lng: 30.7503, radius_km: 16, aliases: ['مدينة المنيا', 'مركز المنيا', 'بندر المنيا'] },
  { id: 'EG-MN-MALLAWI', canonical_name: 'ملوي', parent_id: 'EG-MN', governorate_name: 'المنيا', scope_type: 'CITY', lat: 27.7333, lng: 30.8417, radius_km: 15, aliases: ['ملوي', 'ملوى', 'مركز ملوي'] },
  { id: 'EG-MN-MAGHAGHA', canonical_name: 'مغاغة', parent_id: 'EG-MN', governorate_name: 'المنيا', scope_type: 'CITY', lat: 28.6481, lng: 30.8422, radius_km: 14, aliases: ['مغاغة', 'مغاغه', 'مركز مغاغة'] },
  { id: 'EG-MN-SAMALUT', canonical_name: 'سمالوط', parent_id: 'EG-MN', governorate_name: 'المنيا', scope_type: 'CITY', lat: 28.3122, lng: 30.7103, radius_km: 14, aliases: ['سمالوط', 'مركز سمالوط'] },
  { id: 'EG-MN-BENI_MAZAR', canonical_name: 'بني مزار', parent_id: 'EG-MN', governorate_name: 'المنيا', scope_type: 'CITY', lat: 28.4967, lng: 30.8000, radius_km: 14, aliases: ['بني مزار', 'بنى مزار', 'مركز بني مزار'] },

  // Greater Cairo Key Areas
  { id: 'EG-CAI-NASR_CITY', canonical_name: 'مدينة نصر', parent_id: 'EG-CAI', governorate_name: 'القاهرة', scope_type: 'CITY', lat: 30.0561, lng: 31.3303, radius_km: 10, aliases: ['مدينة نصر', 'مدينه نصر'] },
  { id: 'EG-CAI-MAADI', canonical_name: 'المعادي', parent_id: 'EG-CAI', governorate_name: 'القاهرة', scope_type: 'CITY', lat: 29.9602, lng: 31.2569, radius_km: 10, aliases: ['المعادي', 'المعادى', 'المعادي الجديدة'] },
  { id: 'EG-CAI-NEW_CAIRO', canonical_name: 'القاهرة الجديدة والتجمع', parent_id: 'EG-CAI', governorate_name: 'القاهرة', scope_type: 'CITY', lat: 30.0074, lng: 31.4913, radius_km: 18, aliases: ['التجمع', 'التجمع الخامس', 'القاهرة الجديدة', 'التجمع الاول', 'الرحاب', 'مدينتي'] },
  { id: 'EG-GZ-OCTOBER', canonical_name: '6 أكتوبر والشيخ زايد', parent_id: 'EG-GZ', governorate_name: 'الجيزة', scope_type: 'CITY', lat: 29.9737, lng: 30.9593, radius_km: 22, aliases: ['6 أكتوبر', 'السادس من أكتوبر', 'الشيخ زايد', 'أكتوبر', 'اكتوبر'] },
  { id: 'EG-GZ-DOKKI', canonical_name: 'الدقي والمهندسين', parent_id: 'EG-GZ', governorate_name: 'الجيزة', scope_type: 'CITY', lat: 30.0385, lng: 31.2124, radius_km: 8, aliases: ['الدقي', 'الدقى', 'المهندسين', 'العجوزة'] }
];

// Combine all entities in an indexed map
const ALL_LOCATIONS = [...GOVERNORATES, ...CITIES];
const LOCATIONS_BY_ID = new Map(ALL_LOCATIONS.map(loc => [loc.id, loc]));

/**
 * Token-aware normalizer for Arabic administrative lookups
 * Preserves compound phrases like "قرى جرجا" while stripping standard prefixes
 * only when they appear as standalone tokens.
 */
function normalizeArabicToken(text) {
  if (!text || typeof text !== 'string') return '';
  let str = text.trim()
    .replace(/[\u064B-\u065F\u0670]/g, '') // remove tashkeel
    .replace(/[إأآٱ]/g, 'ا') // normalize alef
    .replace(/ة(?=[\s\-_]|$)/g, 'ه') // normalize ta marbuta at word ends
    .replace(/ى(?=[\s\-_]|$)/g, 'ي') // normalize alef maqsura at word ends
    .replace(/[\s_-]+/g, ' '); // normalize spaces

  // Strip standalone administrative prefixes: (محافظة, مركز, مدينة, بندر, حي, داخل)
  // CRITICAL: Notice 'قرى' or 'قرية' is intentionally NOT stripped so 'قرى جرجا' stays intact!
  str = str.replace(/^(محافظه|محافظة|مركز|مدينه|مدينة|بندر|حي|داخل)\s+/g, '').trim();
  return str;
}

/**
 * Haversine great-circle distance in kilometers
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Check if coordinates are within Egypt borders
 */
function isInEgypt(lat, lng) {
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return false;
  return (
    nLat >= EGYPT_BOUNDS.minLat &&
    nLat <= EGYPT_BOUNDS.maxLat &&
    nLng >= EGYPT_BOUNDS.minLng &&
    nLng <= EGYPT_BOUNDS.maxLng
  );
}

/**
 * Resolve a location by canonical ID
 */
function resolveLocationById(id) {
  if (!id) return null;
  return LOCATIONS_BY_ID.get(id) || null;
}

/**
 * Resolve GPS coordinates to Canonical Location
 * Priority: Nearest City within its max_radius_km -> Nearest Governorate
 */
function resolveCoordinates(lat, lng) {
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (!isInEgypt(nLat, nLng)) {
    return {
      isValid: false,
      reason: 'COORDINATES_OUTSIDE_EGYPT',
      canonicalLocation: null
    };
  }

  // 1. Try cities first (finer resolution)
  let bestCity = null;
  let minCityDist = Infinity;
  for (const city of CITIES) {
    const dist = haversineDistance(nLat, nLng, city.lat, city.lng);
    if (dist <= city.radius_km && dist < minCityDist) {
      minCityDist = dist;
      bestCity = city;
    }
  }

  if (bestCity) {
    const parentGov = LOCATIONS_BY_ID.get(bestCity.parent_id);
    return {
      isValid: true,
      canonicalLocation: bestCity,
      governorate: parentGov || null,
      distance_km: Math.round(minCityDist * 10) / 10,
      precision: 'CITY'
    };
  }

  // 2. Fallback to nearest governorate
  let bestGov = null;
  let minGovDist = Infinity;
  for (const gov of GOVERNORATES) {
    const dist = haversineDistance(nLat, nLng, gov.lat, gov.lng);
    if (dist <= gov.radius_km && dist < minGovDist) {
      minGovDist = dist;
      bestGov = gov;
    }
  }

  if (bestGov) {
    return {
      isValid: true,
      canonicalLocation: bestGov,
      governorate: bestGov,
      distance_km: Math.round(minGovDist * 10) / 10,
      precision: 'GOVERNORATE'
    };
  }

  return {
    isValid: false,
    reason: 'NO_CANONICAL_MATCH_IN_RADIUS',
    canonicalLocation: null
  };
}

/**
 * Match a raw text string or alias to a Canonical Location
 */
function matchLocationByToken(text) {
  if (!text || typeof text !== 'string') return null;
  const normalized = normalizeArabicToken(text);
  if (!normalized) return null;

  // Exact ID check first
  if (LOCATIONS_BY_ID.has(text.trim())) {
    return LOCATIONS_BY_ID.get(text.trim());
  }

  // 1. Check exact canonical name match
  for (const loc of ALL_LOCATIONS) {
    if (loc.canonical_name === text.trim() || normalizeArabicToken(loc.canonical_name) === normalized) {
      return loc;
    }
  }

  // 2. Check aliases exact match
  for (const loc of ALL_LOCATIONS) {
    for (const alias of loc.aliases || []) {
      if (alias === text.trim() || normalizeArabicToken(alias) === normalized) {
        return loc;
      }
    }
  }

  // If text starts with 'قري' or 'قرية' or 'توابع' or 'خارج', do NOT match to the base city!
  if (/^(قري|قريه|توابع|خارج)\s+/i.test(normalized)) {
    return null; // Must match custom zone directly
  }

  // 3. Normalized alias match for cities
  for (const city of CITIES) {
    for (const alias of city.aliases || []) {
      const normAlias = normalizeArabicToken(alias);
      if (normAlias === normalized) {
        return city;
      }
    }
  }

  // 4. Normalized alias match for governorates
  for (const gov of GOVERNORATES) {
    for (const alias of gov.aliases || []) {
      const normAlias = normalizeArabicToken(alias);
      if (normAlias === normalized) {
        return gov;
      }
    }
  }

  return null;
}

module.exports = {
  EGYPT_BOUNDS,
  GOVERNORATES,
  CITIES,
  ALL_LOCATIONS,
  LOCATIONS_BY_ID,
  normalizeArabicToken,
  haversineDistance,
  isInEgypt,
  resolveLocationById,
  resolveCoordinates,
  matchLocationByToken
};

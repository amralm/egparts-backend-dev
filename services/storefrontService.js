const { supabase } = require('./supabase');
const { sanitizeIlikeTerm } = require('../utils/postgrest');
const { normalizeTenantSettings } = require('./tenantContentNormalizer');

async function getTrackingPixels(storeId) {
  try {
    const { data, error } = await supabase
      .from('store_apps')
      .select('settings, is_active, platform_apps(slug)')
      .eq('store_id', storeId)
      .eq('is_active', true);

    if (error || !Array.isArray(data)) return {};

    const pixels = {};
    for (const item of data) {
      const slug = item.platform_apps?.slug;
      const s = item.settings || {};
      if (slug === 'meta-pixel' && s.pixel_id) {
        pixels.meta_pixel_id = s.pixel_id;
        pixels.meta_pixel_enabled = true;
      } else if (slug === 'tiktok-pixel' && s.pixel_id) {
        pixels.tiktok_pixel_id = s.pixel_id;
        pixels.tiktok_pixel_enabled = true;
      } else if (slug === 'google-analytics' && s.measurement_id) {
        pixels.ga4_id = s.measurement_id;
        pixels.ga4_enabled = true;
      } else if (slug === 'snapchat-pixel' && s.pixel_id) {
        pixels.snapchat_pixel_id = s.pixel_id;
        pixels.snapchat_pixel_enabled = true;
      }
    }
    return pixels;
  } catch {
    return {};
  }
}

async function getSettings(storeId) {
  const [settingsRes, trackingPixels] = await Promise.all([
    supabase
      .from('site_settings')
      .select('*')
      .eq('store_id', storeId)
      .maybeSingle(),
    getTrackingPixels(storeId)
  ]);

  if (settingsRes.error) throw settingsRes.error;
  const data = settingsRes.data || {};

  let activeTheme = null;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.theme_id);
  const THEME_SLUG_TO_UUID = {
    'midnight': '9d08ec99-ea33-49b8-9d02-0a2c4fd1b594',
    'ocean': 'c0876cda-6b75-407f-9df0-236d55698f44',
    'emerald': '36f01357-7449-4cf5-9bd3-e5e38dcdd030',
    'sunset': 'a6fb14a1-c0fa-478f-8ad6-82a44bd02ee0',
    'minimal': '9970d99b-d796-4ab5-9370-d6475863313c',
    'royal-purple': 'ed0ba5c3-e9b0-414e-9406-0072ffc74e36',
    'golden-luxury': 'f14fd347-5549-425f-b8bf-8032d970bc47',
    'cyber-teal': '51ef2b1e-b794-451b-871d-1592ec2167cf',
    'rose-pink': '89eabc48-6412-4082-a277-30acfe1a57c9',
    'earth-brown': '8e487365-b840-413c-8f6b-11faeacb22ed'
  };

  const targetThemeUuid = isUuid
    ? data.theme_id
    : (THEME_SLUG_TO_UUID[data.theme_id] || '9d08ec99-ea33-49b8-9d02-0a2c4fd1b594');

  if (targetThemeUuid) {
    const { data: themeData, error: themeError } = await supabase
      .from('platform_themes')
      .select('id, name, name_en, light_tokens, dark_tokens')
      .eq('id', targetThemeUuid)
      .eq('is_published', true)
      .maybeSingle();
    if (themeError) throw themeError;
    activeTheme = themeData;
  }
  
  return normalizeTenantSettings({
    ...data,
    active_theme: activeTheme || null,
    tracking_pixels: trackingPixels
  });
}

async function getHome(storeId) {
  const [banners, latest, trending, settings] = await Promise.all([
    supabase.from('banners').select('*').eq('is_active', true).eq('store_id', storeId).order('order_index', { ascending: true }),
    supabase.from('products').select('*').eq('is_active', true).eq('is_deleted', false).eq('store_id', storeId).gt('stock_quantity', 0).order('created_at', { ascending: false }).limit(4),
    supabase.from('products').select('*').eq('is_active', true).eq('is_deleted', false).eq('store_id', storeId).gt('stock_quantity', 0).order('stock_quantity', { ascending: true }).limit(4),
    getSettings(storeId)
  ]);

  if (banners.error) throw banners.error;
  if (latest.error) throw latest.error;
  if (trending.error) throw trending.error;

  return {
    banners: banners.data || [],
    latest_products: latest.data || [],
    trending_products: trending.data || [],
    settings: settings || {}
  };
}

async function searchProducts(storeId, query, limit = 5) {
  const { data, error } = await supabase
    .from('products')
    .select('id, name, image, price')
    .eq('store_id', storeId)
    .eq('is_active', true)
    .eq('is_deleted', false)
    .ilike('name', `%${query}%`)
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function getCatalogMeta(storeId) {
  const [catData, brandData] = await Promise.all([
    supabase.from('products').select('category').eq('store_id', storeId).eq('is_active', true).eq('is_deleted', false),
    supabase.from('products').select('brand').eq('store_id', storeId).eq('is_active', true).eq('is_deleted', false)
  ]);
  if (catData.error) throw catData.error;
  if (brandData.error) throw brandData.error;
  return {
    categories: ['All', ...new Set((catData.data || []).map((item) => item.category?.trim()).filter(Boolean))],
    brands: ['All', ...new Set((brandData.data || []).map((item) => item.brand?.trim()).filter(Boolean))]
  };
}

async function listCatalogProducts(storeId, filters = {}) {
  const pageSize = Math.min(Number(filters.limit) || 20, 50);
  const page = Math.max(Number(filters.page) || 0, 0);
  const needsCount = filters.count === 'true' || page === 0;
  let query = supabase
    .from('products')
    .select('*', needsCount ? { count: 'exact' } : undefined)
    .eq('store_id', storeId)
    .eq('is_active', true)
    .eq('is_deleted', false);

  if (filters.q) {
    // PostgREST's .or() syntax is an expression language. Never interpolate
    // raw query text into it; strip operators and cap the search term first.
    const safeSearch = sanitizeIlikeTerm(filters.q);
    if (safeSearch) query = query.or(`name.ilike.%${safeSearch}%,part_number.ilike.%${safeSearch}%,category.ilike.%${safeSearch}%`);
  }
  if (filters.category && filters.category !== 'All') query = query.eq('category', filters.category.trim());
  if (filters.brand && filters.brand !== 'All') query = query.eq('brand', filters.brand.trim());
  const minPrice = Number(filters.min);
  const maxPrice = Number(filters.max);
  const hasCustomMin = Number.isFinite(minPrice) && minPrice > 0;
  const hasCustomMax = Number.isFinite(maxPrice) && maxPrice > 0 && maxPrice < 100000;

  if (hasCustomMin && hasCustomMax) {
    query = query.gte('price', minPrice).lte('price', maxPrice);
  } else if (hasCustomMin) {
    query = query.gte('price', minPrice);
  } else if (hasCustomMax) {
    query = query.or(`price.lte.${maxPrice},price.is.null`);
  }

  if (filters.sort === 'price-asc') query = query.order('price', { ascending: true, nullsFirst: false });
  else if (filters.sort === 'price-desc') query = query.order('price', { ascending: false, nullsFirst: false });
  else if (filters.sort === 'popular') query = query.order('stock_quantity', { ascending: false });
  else query = query.order('created_at', { ascending: false });

  const from = page * pageSize;
  const to = from + pageSize - 1;
  const { data, count, error } = await query.range(from, to);
  if (error) throw error;
  return { products: data || [], count };
}

async function getSocialProofProducts(storeId) {
  const { data, error } = await supabase
    .from('products')
    .select('id, name, image')
    .eq('store_id', storeId)
    .eq('is_active', true)
    .eq('is_deleted', false)
    .limit(100);
  if (error) throw error;
  return data || [];
}

async function validateCart(storeId, items = []) {
  if (!items.length) return { products: [], variants: [] };
  const productIds = items.map(i => (typeof i === 'object' && i !== null ? i.id : i)).filter(Boolean);
  const variantIds = items.map(i => (typeof i === 'object' && i !== null ? i.variant_id : null)).filter(Boolean);

  const { data: products, error } = await supabase
    .from('products')
    .select('id, is_active, is_deleted, stock_quantity, price, has_variants')
    .in('id', productIds)
    .eq('store_id', storeId);
  if (error) throw error;

  let variants = [];
  if (variantIds.length > 0) {
    const { data: varData } = await supabase
      .from('product_variants')
      .select('id, product_id, is_active, is_archived, stock_quantity, price')
      .in('id', variantIds)
      .eq('store_id', storeId);
    variants = varData || [];
  }

  return { products: products || [], variants: variants || [] };
}

module.exports = {
  getSettings,
  getHome,
  searchProducts,
  getCatalogMeta,
  listCatalogProducts,
  getSocialProofProducts,
  validateCart
};

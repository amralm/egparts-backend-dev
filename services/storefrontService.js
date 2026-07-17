const { supabase } = require('./supabase');

async function getSettings(storeId) {
  const { data, error } = await supabase
    .from('site_settings')
    .select('*')
    .eq('store_id', storeId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.theme_id) return data || {};

  const { data: activeTheme, error: themeError } = await supabase
    .from('platform_themes')
    .select('id, name, name_en, light_tokens, dark_tokens')
    .eq('id', data.theme_id)
    .eq('is_published', true)
    .maybeSingle();
  if (themeError) throw themeError;
  return { ...data, active_theme: activeTheme || null };
}

async function getHome(storeId) {
  const [banners, latest, trending, settings] = await Promise.all([
    supabase.from('banners').select('*').eq('is_active', true).eq('store_id', storeId).order('order_index', { ascending: true }),
    supabase.from('products').select('*').eq('is_active', true).neq('is_deleted', true).eq('store_id', storeId).gt('stock_quantity', 0).order('created_at', { ascending: false }).limit(4),
    supabase.from('products').select('*').eq('is_active', true).neq('is_deleted', true).eq('store_id', storeId).gt('stock_quantity', 0).order('stock_quantity', { ascending: true }).limit(4),
    supabase.from('site_settings').select('*').eq('store_id', storeId).maybeSingle()
  ]);

  [banners, latest, trending, settings].forEach((result) => {
    if (result.error) throw result.error;
  });

  return {
    banners: banners.data || [],
    latest_products: latest.data || [],
    trending_products: trending.data || [],
    settings: settings.data || null
  };
}

async function searchProducts(storeId, query, limit = 5) {
  const { data, error } = await supabase
    .from('products')
    .select('id, name, image, price')
    .eq('store_id', storeId)
    .eq('is_active', true)
    .neq('is_deleted', true)
    .ilike('name', `%${query}%`)
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function getCatalogMeta(storeId) {
  const [catData, brandData] = await Promise.all([
    supabase.from('products').select('category').eq('store_id', storeId).eq('is_active', true),
    supabase.from('products').select('brand').eq('store_id', storeId).eq('is_active', true)
  ]);
  if (catData.error) throw catData.error;
  if (brandData.error) throw brandData.error;
  return {
    categories: ['All', ...new Set((catData.data || []).map((item) => item.category).filter(Boolean))],
    brands: ['All', ...new Set((brandData.data || []).map((item) => item.brand).filter(Boolean))]
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
    .neq('is_deleted', true);

  if (filters.q) query = query.or(`name.ilike.%${filters.q}%,part_number.ilike.%${filters.q}%,category.ilike.%${filters.q}%`);
  if (filters.category && filters.category !== 'All') query = query.eq('category', filters.category);
  if (filters.brand && filters.brand !== 'All') query = query.eq('brand', filters.brand);
  query = query.gte('price', Number(filters.min) || 0).lte('price', Number(filters.max) || 100000);

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
    .neq('is_deleted', true)
    .limit(100);
  if (error) throw error;
  return data || [];
}

async function validateCart(storeId, ids = []) {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from('products')
    .select('id, is_active, is_deleted, stock_quantity, price')
    .in('id', ids)
    .eq('store_id', storeId);
  if (error) throw error;
  return data || [];
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

const { supabase } = require('./supabase');
const { normalizeThemeSettings } = require('./themeSettingsService');

async function findProducts(storeId, { ids, query, guaranteeOnly } = {}) {
  let q = supabase
    .from('products')
    .select('id, name, image')
    .eq('store_id', storeId);

  if (Array.isArray(ids) && ids.length > 0) q = q.in('id', ids);
  if (query) q = q.ilike('name', `%${query}%`).limit(8);
  if (guaranteeOnly) q = q.eq('guarantee_badge', true);

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function getSettings(storeId) {
  const [settingsResult, storeResult] = await Promise.all([
    supabase
      .from('site_settings')
      .select('*')
      .eq('store_id', storeId),
    supabase
      .from('stores')
      .select('business_type')
      .eq('id', storeId)
      .maybeSingle()
  ]);

  if (settingsResult.error) throw settingsResult.error;
  if (storeResult.error) throw storeResult.error;

  return {
    rows: settingsResult.data || [],
    business_type: storeResult.data?.business_type || 'general'
  };
}

async function saveSettings(storeId, settings, businessType, guaranteeProductIds = []) {
  const { id, store_id, created_at, updated_at, ...updatePayload } = settings || {};
  const safePayload = normalizeThemeSettings(updatePayload);

  const { data, error } = await supabase
    .from('site_settings')
    .update(safePayload)
    .eq('store_id', storeId)
    .select()
    .maybeSingle();
  if (error) throw error;

  if (businessType) {
    const { error: storeErr } = await supabase
      .from('stores')
      .update({ business_type: businessType })
      .eq('id', storeId);
    if (storeErr) throw storeErr;
  }

  if (guaranteeProductIds.length > 0) {
    await supabase.from('products').update({ guarantee_badge: false }).eq('store_id', storeId).neq('guarantee_badge', false);
    await supabase.from('products').update({ guarantee_badge: true }).eq('store_id', storeId).in('id', guaranteeProductIds);
  } else {
    await supabase.from('products').update({ guarantee_badge: false }).eq('store_id', storeId).eq('guarantee_badge', true);
  }

  return data;
}

async function applyPublishedTheme(storeId, themeId) {
  const { data: theme, error: themeError } = await supabase
    .from('platform_themes')
    .select('id')
    .eq('id', themeId)
    .eq('is_published', true)
    .maybeSingle();
  if (themeError) throw themeError;
  if (!theme) {
    const error = new Error('Theme is not available.');
    error.statusCode = 404;
    throw error;
  }

  const { data, error } = await supabase
    .from('site_settings')
    .update({ theme_id: theme.id, theme_overrides: {} })
    .eq('store_id', storeId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

module.exports = {
  findProducts,
  getSettings,
  saveSettings,
  applyPublishedTheme
};

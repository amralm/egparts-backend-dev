'use strict';

const { supabase } = require('./supabase');
const { normalizeThemeSettings } = require('./themeSettingsService');
const { safeDeleteR2Objects, extractR2Key } = require('../utils/r2Helper');
const logger = require('../utils/logger');

const SUPPORTED_BUSINESS_TYPES = new Set([
  'general', 'automotive', 'fashion', 'electronics', 'grocery', 'health',
  'bookstore', 'juice_bar', 'restaurant', 'bakery', 'pharmacy', 'services'
]);

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
  // store_niche is a frontend form field, not a site_settings column.
  // The canonical value is persisted separately as stores.business_type.
  const { id, store_id, created_at, updated_at, store_niche, ...updatePayload } = settings || {};
  if (businessType && !SUPPORTED_BUSINESS_TYPES.has(businessType)) {
    const error = new Error('Unsupported store specialization.');
    error.statusCode = 400;
    error.code = 'UNSUPPORTED_BUSINESS_TYPE';
    throw error;
  }
  if (updatePayload.proof_retention_days !== undefined && updatePayload.proof_retention_days !== null) {
    const retentionDays = Number(updatePayload.proof_retention_days);
    if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650) {
      const error = new Error('proof_retention_days must be an integer between 0 and 3650');
      error.statusCode = 400;
      throw error;
    }
    updatePayload.proof_retention_days = retentionDays;
  }
  const safePayload = normalizeThemeSettings(updatePayload);

  // 1. Fetch current settings to detect replaced media
  const { data: currentSettings } = await supabase
    .from('site_settings')
    .select('logo_url, brand_logo, hero_image, about_image, favicon_url')
    .eq('store_id', storeId)
    .maybeSingle();

  const { data, error } = await supabase
    .from('site_settings')
    .update(safePayload)
    .eq('store_id', storeId)
    .select()
    .maybeSingle();

  if (error) throw error;
  let finalData = data;
  if (!data) {
    const { data: upsertData, error: upsertError } = await supabase
      .from('site_settings')
      .upsert({ store_id: storeId, ...safePayload }, { onConflict: 'store_id' })
      .select()
      .maybeSingle();
    if (upsertError) throw upsertError;
    finalData = upsertData;
  }

  // 2. Clean up replaced images from Cloudflare R2
  if (currentSettings) {
    const mediaKeysToDelete = [];
    const checkFields = ['logo_url', 'brand_logo', 'hero_image', 'about_image', 'favicon_url'];

    for (const field of checkFields) {
      const oldVal = currentSettings[field];
      const newVal = safePayload[field];
      if (oldVal && newVal && oldVal !== newVal) {
        mediaKeysToDelete.push(oldVal);
      }
    }

    if (mediaKeysToDelete.length > 0) {
      safeDeleteR2Objects(mediaKeysToDelete).catch((delErr) => {
        logger.warn(`[settingsAdminService] Failed to delete replaced settings media: ${delErr.message}`);
      });
    }
  }

  const storeUpdates = {};
  if (businessType) storeUpdates.business_type = businessType;
  if (updatePayload.brand_name && typeof updatePayload.brand_name === 'string' && updatePayload.brand_name.trim()) {
    storeUpdates.name = updatePayload.brand_name.trim();
  }
  if (Object.keys(storeUpdates).length > 0) {
    storeUpdates.updated_at = new Date().toISOString();
    const { error: storeErr } = await supabase
      .from('stores')
      .update(storeUpdates)
      .eq('id', storeId);
    if (storeErr) throw storeErr;
  }

  if (guaranteeProductIds.length > 0) {
    await supabase.from('products').update({ guarantee_badge: false }).eq('store_id', storeId).neq('guarantee_badge', false);
    await supabase.from('products').update({ guarantee_badge: true }).eq('store_id', storeId).in('id', guaranteeProductIds);
  } else {
    await supabase.from('products').update({ guarantee_badge: false }).eq('store_id', storeId).eq('guarantee_badge', true);
  }

  return finalData;
}

async function applyPublishedTheme(storeId, themeId) {
  if (!themeId || typeof themeId !== 'string') {
    const error = new Error('Valid theme_id is required.');
    error.statusCode = 400;
    error.code = 'INVALID_THEME_ID';
    throw error;
  }

  const trimmedId = themeId.trim();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmedId);

  if (isUuid) {
    // Check that the platform theme exists and is published
    const { data: dbTheme, error: themeError } = await supabase
      .from('platform_themes')
      .select('id, name, is_published')
      .eq('id', trimmedId)
      .maybeSingle();

    if (themeError) throw themeError;
    if (!dbTheme) {
      const error = new Error('Theme not found.');
      error.statusCode = 404;
      error.code = 'THEME_NOT_FOUND';
      throw error;
    }
    if (!dbTheme.is_published) {
      const error = new Error('Theme is not published.');
      error.statusCode = 400;
      error.code = 'THEME_NOT_PUBLISHED';
      throw error;
    }
  }

  const updatePayload = {
    theme_id: trimmedId,
    theme_overrides: {}
  };

  const { data: updated, error: updateError } = await supabase
    .from('site_settings')
    .update(updatePayload)
    .eq('store_id', storeId)
    .select()
    .maybeSingle();

  if (updateError) throw updateError;
  let finalData = updated;

  if (!updated) {
    const { data: upserted, error: upsertError } = await supabase
      .from('site_settings')
      .upsert({ store_id: storeId, ...updatePayload }, { onConflict: 'store_id' })
      .select()
      .maybeSingle();
    if (upsertError) throw upsertError;
    finalData = upserted;
  }

  return finalData;
}

module.exports = {
  getSettings,
  saveSettings,
  findProducts,
  applyPublishedTheme
};

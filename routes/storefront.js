const { apiError } = require('../utils/apiError');
const { sendSuccess } = require('../utils/apiResponse');
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const storefrontService = require('../services/storefrontService');

function requireStore(req, res) {
  if (!req.store?.id) {
    apiError(res, 400, 'Tenant context is required.', 'TENANT_CONTEXT_REQUIRED');
    return null;
  }
  return req.store.id;
}

router.get('/settings', async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const settings = await storefrontService.getSettings(storeId);
    sendSuccess(res, { settings });
  } catch (err) {
    logger.error('[storefront] settings failed:', err.message);
    apiError(res, 500, 'Unable to load settings.', `HTTP_500`);
  }
});

router.get('/themes', async (req, res) => {
  try {
    const { data, error } = await require('../services/supabase').supabase
      .from('platform_themes')
      .select('id, name, name_en, description, sort_order, light_tokens, dark_tokens')
      .eq('is_published', true)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    sendSuccess(res, { items: data || [] });
  } catch (err) {
    logger.error('[storefront] themes failed:', err.message);
    apiError(res, 500, 'Unable to load themes.', `HTTP_500`);
  }
});

router.get('/home', async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const data = await storefrontService.getHome(storeId);
    sendSuccess(res, { ...data });
  } catch (err) {
    logger.error('[storefront] home failed:', err.message);
    apiError(res, 500, 'Unable to load home data.', `HTTP_500`);
  }
});

router.get('/products/search', async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const products = await storefrontService.searchProducts(storeId, req.query.q || '', Number(req.query.limit) || 5);
    sendSuccess(res, { products });
  } catch (err) {
    logger.error('[storefront] product search failed:', err.message);
    apiError(res, 500, 'Unable to search products.', `HTTP_500`);
  }
});

router.get('/catalog/meta', async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const meta = await storefrontService.getCatalogMeta(storeId);
    sendSuccess(res, { ...meta });
  } catch (err) {
    logger.error('[storefront] catalog meta failed:', err.message);
    apiError(res, 500, 'Unable to load catalog metadata.', `HTTP_500`);
  }
});

router.get('/catalog/products', async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const data = await storefrontService.listCatalogProducts(storeId, req.query || {});
    sendSuccess(res, { ...data });
  } catch (err) {
    logger.error('[storefront] catalog products failed:', err.message);
    apiError(res, 500, 'Unable to load catalog products.', `HTTP_500`);
  }
});

router.get('/social-proof/products', async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const products = await storefrontService.getSocialProofProducts(storeId);
    sendSuccess(res, { products });
  } catch (err) {
    logger.error('[storefront] social proof products failed:', err.message);
    apiError(res, 500, 'Unable to load social proof products.', `HTTP_500`);
  }
});

router.post('/cart/validate', async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const items = req.body?.items || [];
    const ids = req.body?.ids || items.map(i => i?.id || i).filter(Boolean);
    const products = await storefrontService.validateCart(storeId, ids);
    sendSuccess(res, { products });
  } catch (err) {
    logger.error('[storefront] cart validate failed:', err.message);
    apiError(res, 500, 'Unable to validate cart.', `HTTP_500`);
  }
});

router.get('/shipping-zones', async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const { data } = await require('../services/supabase').supabase
      .from('shipping_zones')
      .select('id, city_name, shipping_fee')
      .eq('store_id', storeId)
      .order('city_name', { ascending: true });
    sendSuccess(res, { zones: data || [] });
  } catch (err) {
    logger.error('[storefront] shipping zones failed:', err.message);
    apiError(res, 500, 'Unable to load shipping zones.', `HTTP_500`);
  }
});

module.exports = router;

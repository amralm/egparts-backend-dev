const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const storefrontService = require('../services/storefrontService');

function requireStore(req, res) {
  if (!req.store?.id) {
    res.status(400).json({ success: false, code: 'TENANT_CONTEXT_REQUIRED', error: 'Tenant context is required.' });
    return null;
  }
  return req.store.id;
}

router.get('/settings', async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const settings = await storefrontService.getSettings(storeId);
    res.json({ success: true, settings });
  } catch (err) {
    logger.error('[storefront] settings failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to load settings.' });
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
    res.json({ success: true, items: data || [] });
  } catch (err) {
    logger.error('[storefront] themes failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to load themes.' });
  }
});

router.get('/home', async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const data = await storefrontService.getHome(storeId);
    res.json({ success: true, ...data });
  } catch (err) {
    logger.error('[storefront] home failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to load home data.' });
  }
});

router.get('/products/search', async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const products = await storefrontService.searchProducts(storeId, req.query.q || '', Number(req.query.limit) || 5);
    res.json({ success: true, products });
  } catch (err) {
    logger.error('[storefront] product search failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to search products.' });
  }
});

router.get('/catalog/meta', async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const meta = await storefrontService.getCatalogMeta(storeId);
    res.json({ success: true, ...meta });
  } catch (err) {
    logger.error('[storefront] catalog meta failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to load catalog metadata.' });
  }
});

router.get('/catalog/products', async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const data = await storefrontService.listCatalogProducts(storeId, req.query || {});
    res.json({ success: true, ...data });
  } catch (err) {
    logger.error('[storefront] catalog products failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to load catalog products.' });
  }
});

router.get('/social-proof/products', async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const products = await storefrontService.getSocialProofProducts(storeId);
    res.json({ success: true, products });
  } catch (err) {
    logger.error('[storefront] social proof products failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to load social proof products.' });
  }
});

router.post('/cart/validate', async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const products = await storefrontService.validateCart(storeId, req.body?.ids || []);
    res.json({ success: true, products });
  } catch (err) {
    logger.error('[storefront] cart validate failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to validate cart.' });
  }
});

module.exports = router;

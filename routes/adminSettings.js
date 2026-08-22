const { apiError } = require('../utils/apiError');
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { verifyPermission } = require('../middleware/auth');
const settingsAdminService = require('../services/settingsAdminService');

function requireStore(req, res) {
  if (!req.store?.id) {
    apiError(res, 400, 'Tenant context is required.', 'TENANT_CONTEXT_REQUIRED');
    return null;
  }
  return req.store.id;
}

router.get('/products', verifyPermission('settings.view'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const ids = req.query.ids ? String(req.query.ids).split(',').filter(Boolean) : undefined;
    const products = await settingsAdminService.findProducts(storeId, {
      ids,
      query: req.query.q,
      guaranteeOnly: req.query.guarantee === 'true'
    });
    res.json({ success: true, products });
  } catch (err) {
    logger.error('[admin-settings] products failed:', err.message);
    apiError(res, 500, 'Unable to load products.', `HTTP_500`);
  }
});

router.get('/', verifyPermission('settings.view'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const payload = await settingsAdminService.getSettings(storeId);
    res.json({ success: true, ...payload });
  } catch (err) {
    logger.error('[admin-settings] get failed:', err.message);
    apiError(res, 500, 'Unable to load settings.', `HTTP_500`);
  }
});

router.put('/', verifyPermission('settings.update'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const settings = await settingsAdminService.saveSettings(
      storeId,
      req.body?.settings || {},
      req.body?.businessType,
      req.body?.guaranteeProductIds || []
    );
    
    // Invalidate cache
    const { tenantCache } = require('../utils/cache');
    if (req.store.subdomain) tenantCache.delete(req.store.subdomain);
    if (req.store.custom_domain) tenantCache.delete(req.store.custom_domain);

    res.json({ success: true, settings });
  } catch (err) {
    logger.error('[admin-settings] save failed:', err.message);
    apiError(res, err.statusCode || 500, 'Unable to save settings.', 'SETTINGS_SAVE_FAILED');
  }
});

router.patch('/theme', verifyPermission('settings.update'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const settings = await settingsAdminService.applyPublishedTheme(storeId, req.body?.theme_id);
    
    // Invalidate cache
    const { tenantCache } = require('../utils/cache');
    if (req.store.subdomain) tenantCache.delete(req.store.subdomain);
    if (req.store.custom_domain) tenantCache.delete(req.store.custom_domain);

    res.json({ success: true, settings });
  } catch (err) {
    logger.error('[admin-settings] apply theme failed:', err.message);
    apiError(res, err.statusCode || 500, 'Unable to apply theme.', 'THEME_APPLY_FAILED');
  }
});

module.exports = router;

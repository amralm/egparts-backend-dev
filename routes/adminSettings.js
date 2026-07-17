const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { verifyPermission } = require('../middleware/auth');
const settingsAdminService = require('../services/settingsAdminService');

function requireStore(req, res) {
  if (!req.store?.id) {
    res.status(400).json({ success: false, code: 'TENANT_CONTEXT_REQUIRED', error: 'Tenant context is required.' });
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
    res.status(500).json({ success: false, error: 'Unable to load products.' });
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
    res.status(500).json({ success: false, error: 'Unable to load settings.' });
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
    res.json({ success: true, settings });
  } catch (err) {
    logger.error('[admin-settings] save failed:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: 'Unable to save settings.' });
  }
});

router.patch('/theme', verifyPermission('settings.update'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;
  try {
    const settings = await settingsAdminService.applyPublishedTheme(storeId, req.body?.theme_id);
    res.json({ success: true, settings });
  } catch (err) {
    logger.error('[admin-settings] apply theme failed:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: 'Unable to apply theme.' });
  }
});

module.exports = router;

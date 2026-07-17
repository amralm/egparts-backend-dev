const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { verifyPermission } = require('../middleware/auth');
const contentAdminService = require('../services/contentAdminService');

function requireStore(req, res) {
  if (!req.store?.id) {
    res.status(400).json({ success: false, code: 'TENANT_CONTEXT_REQUIRED', error: 'Tenant context is required.' });
    return null;
  }
  return req.store.id;
}

router.get('/categories', verifyPermission('settings.view'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  try {
    const categories = await contentAdminService.listProductCategories(storeId);
    res.json({ success: true, categories });
  } catch (err) {
    logger.error('[admin-content] categories failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to load categories.' });
  }
});

router.get('/', verifyPermission('settings.view'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  try {
    const content = await contentAdminService.getStoreContent(storeId);
    res.json({ success: true, content });
  } catch (err) {
    logger.error('[admin-content] get failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to load content.' });
  }
});

router.put('/', verifyPermission('settings.update'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  try {
    const content = await contentAdminService.updateStoreContent(storeId, req.body?.content || {});
    res.json({ success: true, content });
  } catch (err) {
    logger.error('[admin-content] update failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to save content.' });
  }
});

module.exports = router;

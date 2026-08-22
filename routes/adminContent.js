const { apiError } = require('../utils/apiError');
const { sendSuccess } = require('../utils/apiResponse');
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { verifyPermission } = require('../middleware/auth');
const contentAdminService = require('../services/contentAdminService');

function requireStore(req, res) {
  if (!req.store?.id) {
    apiError(res, 400, 'Tenant context is required.', 'TENANT_CONTEXT_REQUIRED');
    return null;
  }
  return req.store.id;
}

router.get('/categories', verifyPermission('settings.view'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  try {
    const categories = await contentAdminService.listProductCategories(storeId);
    sendSuccess(res, { categories });
  } catch (err) {
    logger.error('[admin-content] categories failed:', err.message);
    apiError(res, 500, 'Unable to load categories.', `HTTP_500`);
  }
});

router.get('/', verifyPermission('settings.view'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  try {
    const content = await contentAdminService.getStoreContent(storeId);
    sendSuccess(res, { content });
  } catch (err) {
    logger.error('[admin-content] get failed:', err.message);
    apiError(res, 500, 'Unable to load content.', `HTTP_500`);
  }
});

router.put('/', verifyPermission('settings.update'), async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  try {
    const content = await contentAdminService.updateStoreContent(storeId, req.body?.content || {});
    sendSuccess(res, { content });
  } catch (err) {
    logger.error('[admin-content] update failed:', err.message);
    apiError(res, 500, 'Unable to save content.', `HTTP_500`);
  }
});

module.exports = router;

const express = require('express');
const { verifyPermission } = require('../middleware/auth');
const bannerAdminService = require('../services/bannerAdminService');
const logger = require('../utils/logger');

const router = express.Router();

function getStoreId(req, res) {
  const storeId = req.store?.id;
  if (!storeId) {
    res.status(403).json({ error: 'Tenant context required' });
    return null;
  }
  return storeId;
}

function sendError(res, err) {
  const status = err.statusCode || 500;
  return res.status(status).json({
    error: status >= 500 ? 'Internal server error' : (err.code || 'Request failed')
  });
}

router.get('/', verifyPermission('banners.view'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;
  try {
    const banners = await bannerAdminService.listBanners(storeId);
    res.json({ success: true, banners });
  } catch (err) {
    logger.error('[admin-banners] list failed:', err.message);
    sendError(res, err);
  }
});

router.post('/', verifyPermission('banners.manage'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;
  try {
    const banner = await bannerAdminService.createBanner(storeId, req.body || {});
    res.status(201).json({ success: true, banner });
  } catch (err) {
    logger.error('[admin-banners] create failed:', err.message);
    sendError(res, err);
  }
});

router.put('/:id', verifyPermission('banners.manage'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;
  try {
    const banner = await bannerAdminService.updateBanner(storeId, req.params.id, req.body || {});
    res.json({ success: true, banner });
  } catch (err) {
    logger.error('[admin-banners] update failed:', err.message);
    sendError(res, err);
  }
});

router.patch('/:id/status', verifyPermission('banners.manage'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;
  try {
    const banner = await bannerAdminService.setBannerStatus(storeId, req.params.id, req.body?.is_active);
    res.json({ success: true, banner });
  } catch (err) {
    logger.error('[admin-banners] status failed:', err.message);
    sendError(res, err);
  }
});

router.delete('/:id', verifyPermission('banners.manage'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;
  try {
    const result = await bannerAdminService.deleteBanner(storeId, req.params.id);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('[admin-banners] delete failed:', err.message);
    sendError(res, err);
  }
});

module.exports = router;

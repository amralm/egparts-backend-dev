const { apiError } = require('../utils/apiError');
const { sendSuccess } = require('../utils/apiResponse');
const express = require('express');
const { verifyPermission } = require('../middleware/auth');
const bannerAdminService = require('../services/bannerAdminService');
const logger = require('../utils/logger');
const subscriptionLimitService = require('../services/subscriptionLimitService');
const { validateBody } = require('../middleware/requestValidation');
const { bannerSchema } = require('../schemas/catalogSchemas');

const router = express.Router();

function getStoreId(req, res) {
  const storeId = req.store?.id;
  if (!storeId) {
    apiError(res, 403, 'Tenant context required', `HTTP_403`);
    return null;
  }
  return storeId;
}

function sendError(res, err) {
  const status = err.statusCode || 500;
  return apiError(res, status, status >= 500 ? 'Internal server error' : (err.code || 'Request failed'), err.code || `HTTP_${status}`);
}

router.get('/', verifyPermission('banners.view'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;
  try {
    const banners = await bannerAdminService.listBanners(storeId);
    sendSuccess(res, { banners });
  } catch (err) {
    logger.error('[admin-banners] list failed:', err.message);
    sendError(res, err);
  }
});

router.post('/', verifyPermission('banners.manage'), validateBody(bannerSchema), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;
  let reservationKey;
  try {
    reservationKey = req.headers['x-idempotency-key'] || `banner_${Date.now()}`;
    // Keep the API contract aligned with the frontend and upload pipeline.
    // `banners` was a legacy key; production plans expose `banner_images`.
    const isAllowed = await subscriptionLimitService.reserveFeatureUsage(storeId, 'banner_images', 1, reservationKey, 15);
    if (!isAllowed) {
      return apiError(res, 403, 'تجاوزت الحد الأقصى للبنرات الإعلانية المسموح بها في باقتك.', 'FEATURE_LIMIT_EXCEEDED');
    }
    const banner = await bannerAdminService.createBanner(storeId, req.body || {});
    await subscriptionLimitService.commitFeatureUsage(reservationKey);
    sendSuccess(res, { banner }, { status: 201 });
  } catch (err) {
    if (typeof reservationKey !== 'undefined') {
      await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
    }
    logger.error('[admin-banners] create failed:', err.message);
    sendError(res, err);
  }
});

router.put('/:id', verifyPermission('banners.manage'), validateBody(bannerSchema.partial()), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;
  try {
    const banner = await bannerAdminService.updateBanner(storeId, req.params.id, req.body || {});
    sendSuccess(res, { banner });
  } catch (err) {
    logger.error('[admin-banners] update failed:', err.message);
    sendError(res, err);
  }
});

router.patch('/:id/status', verifyPermission('banners.manage'), validateBody(bannerSchema.pick({ is_active: true })), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;
  try {
    const banner = await bannerAdminService.setBannerStatus(storeId, req.params.id, req.body?.is_active);
    sendSuccess(res, { banner });
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
    sendSuccess(res, { ...result });
  } catch (err) {
    logger.error('[admin-banners] delete failed:', err.message);
    sendError(res, err);
  }
});

module.exports = router;

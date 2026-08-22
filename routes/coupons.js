const { apiError } = require('../utils/apiError');
const { sendSuccess } = require('../utils/apiResponse');
const express = require('express');
const { verifyPermission } = require('../middleware/auth');
const couponService = require('../services/couponService');
const logger = require('../utils/logger');
const subscriptionLimitService = require('../services/subscriptionLimitService');
const { validateBody } = require('../middleware/requestValidation');
const { couponSchema, couponValidationSchema } = require('../schemas/catalogSchemas');

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
  const message = status >= 500 ? 'Internal server error' : (err.message || 'Request failed');
  return apiError(res, status, message, err.code || (status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_FAILED'));
}

router.get('/', verifyPermission('coupons.view'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    const coupons = await couponService.listCoupons(storeId);
    sendSuccess(res, { coupons });
  } catch (err) {
    logger.error('[coupons] list failed:', err.message);
    sendError(res, err);
  }
});

router.post('/validate', validateBody(couponValidationSchema), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    const coupon = await couponService.validateCoupon(storeId, req.body?.code, req.body?.subtotal);
    sendSuccess(res, { coupon });
  } catch (err) {
    logger.error('[coupons] validate failed:', err.message);
    const status = err.statusCode || 500;
    const errorData = err.min_order_value !== undefined && err.min_order_value !== null
      ? { min_order_value: err.min_order_value }
      : null;
    apiError(res, status, 'تعذر تطبيق كود الخصم.', err.code || 'COUPON_VALIDATION_FAILED', errorData);
  }
});

router.post('/', verifyPermission('coupons.create'), validateBody(couponSchema), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  let reservationKey;
  try {
    reservationKey = req.headers['x-idempotency-key'] || `coupon_${Date.now()}`;
    const isAllowed = await subscriptionLimitService.reserveFeatureUsage(storeId, 'coupons', 1, reservationKey, 15);
    if (!isAllowed) {
      return apiError(res, 403, 'تجاوزت الحد الأقصى للكوبونات المسموح بها في باقتك.', 'FEATURE_LIMIT_EXCEEDED');
    }
    const coupon = await couponService.createCoupon(storeId, req.body || {});
    await subscriptionLimitService.commitFeatureUsage(reservationKey);
    sendSuccess(res, { coupon }, { status: 201 });
  } catch (err) {
    if (typeof reservationKey !== 'undefined') {
      await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
    }
    logger.error('[coupons] create failed:', err.message);
    sendError(res, err);
  }
});

router.put('/:id', verifyPermission('coupons.update'), validateBody(couponSchema), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    const coupon = await couponService.updateCoupon(storeId, req.params.id, req.body || {});
    sendSuccess(res, { coupon });
  } catch (err) {
    logger.error('[coupons] update failed:', err.message);
    sendError(res, err);
  }
});

router.patch('/:id/status', verifyPermission('coupons.update'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    const coupon = await couponService.setCouponStatus(storeId, req.params.id, req.body?.is_active);
    sendSuccess(res, { coupon });
  } catch (err) {
    logger.error('[coupons] status update failed:', err.message);
    sendError(res, err);
  }
});

router.delete('/:id', verifyPermission('coupons.delete'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    await couponService.deleteCoupon(storeId, req.params.id);
    sendSuccess(res, {});
  } catch (err) {
    logger.error('[coupons] delete failed:', err.message);
    sendError(res, err);
  }
});

module.exports = router;

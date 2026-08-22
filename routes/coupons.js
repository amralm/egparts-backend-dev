const { apiError } = require('../utils/apiError');
const express = require('express');
const { verifyPermission } = require('../middleware/auth');
const couponService = require('../services/couponService');
const logger = require('../utils/logger');
const subscriptionLimitService = require('../services/subscriptionLimitService');

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
  const body = status >= 500
    ? { error: 'Internal server error' }
    : { error: err.code || 'Request failed' };
  return res.status(status).json(body);
}

router.get('/', verifyPermission('coupons.view'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    const coupons = await couponService.listCoupons(storeId);
    res.json({ success: true, coupons });
  } catch (err) {
    logger.error('[coupons] list failed:', err.message);
    sendError(res, err);
  }
});

router.post('/validate', async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    const coupon = await couponService.validateCoupon(storeId, req.body?.code, req.body?.subtotal);
    res.json({ success: true, coupon });
  } catch (err) {
    logger.error('[coupons] validate failed:', err.message);
    const status = err.statusCode || 500;
    res.status(status).json({
      success: false,
      code: err.code || 'COUPON_VALIDATION_FAILED',
      min_order_value: err.min_order_value
    });
  }
});

router.post('/', verifyPermission('coupons.create'), async (req, res) => {
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
    res.status(201).json({ success: true, coupon });
  } catch (err) {
    if (typeof reservationKey !== 'undefined') {
      await subscriptionLimitService.rollbackFeatureUsage(reservationKey);
    }
    logger.error('[coupons] create failed:', err.message);
    sendError(res, err);
  }
});

router.put('/:id', verifyPermission('coupons.update'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    const coupon = await couponService.updateCoupon(storeId, req.params.id, req.body || {});
    res.json({ success: true, coupon });
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
    res.json({ success: true, coupon });
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
    res.json({ success: true });
  } catch (err) {
    logger.error('[coupons] delete failed:', err.message);
    sendError(res, err);
  }
});

module.exports = router;

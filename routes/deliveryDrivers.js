'use strict';

const express = require('express');
const router = express.Router();
const { verifyPermission } = require('../middleware/auth');
const { validateBody } = require('../middleware/requestValidation');
const { createDriverSchema, updateDriverSchema } = require('../schemas/deliveryDriverSchemas');
const deliveryDriverService = require('../services/deliveryDriverService');
const { apiError } = require('../utils/apiError');
const { sendSuccess } = require('../utils/apiResponse');
const logger = require('../utils/logger');

function getStoreId(req, res) {
  const storeId = req.store?.id;
  if (!storeId) {
    apiError(res, 403, 'سياق المتجر مطلوب لهذه العملية.', 'TENANT_CONTEXT_REQUIRED');
    return null;
  }
  return storeId;
}

function sendError(res, err, defaultMsg) {
  const status = err.statusCode || 500;
  return apiError(
    res,
    status,
    err.message || defaultMsg || 'حدث خطأ في معالجة طلب المندوب',
    err.code || `HTTP_${status}`
  );
}

/**
 * 1. List All Store Delivery Drivers
 */
router.get('/', verifyPermission('shipping.manage'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    const drivers = await deliveryDriverService.listDrivers(storeId);
    sendSuccess(res, { drivers });
  } catch (err) {
    logger.error('[deliveryDrivers] List failed:', err.message);
    sendError(res, err, 'تعذر جلب قائمة المناديب');
  }
});

/**
 * 2. Create a Delivery Driver
 */
router.post('/', verifyPermission('shipping.manage'), validateBody(createDriverSchema), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    const driver = await deliveryDriverService.createDriver(storeId, req.body);
    sendSuccess(res, { driver, message: 'تمت إضافة المندوب بنجاح' }, { status: 201 });
  } catch (err) {
    logger.error('[deliveryDrivers] Create failed:', err.message);
    sendError(res, err, 'تعذر إضافة المندوب');
  }
});

/**
 * 3. Update a Delivery Driver
 */
router.put('/:id', verifyPermission('shipping.manage'), validateBody(updateDriverSchema), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    const driver = await deliveryDriverService.updateDriver(storeId, req.params.id, req.body);
    sendSuccess(res, { driver, message: 'تم تحديث بيانات المندوب بنجاح' });
  } catch (err) {
    logger.error('[deliveryDrivers] Update failed:', err.message);
    sendError(res, err, 'تعذر تحديث بيانات المندوب');
  }
});

/**
 * 4. Delete a Delivery Driver
 */
router.delete('/:id', verifyPermission('shipping.manage'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    await deliveryDriverService.deleteDriver(storeId, req.params.id);
    sendSuccess(res, { message: 'تم حذف المندوب بنجاح' });
  } catch (err) {
    logger.error('[deliveryDrivers] Delete failed:', err.message);
    sendError(res, err, 'تعذر حذف المندوب');
  }
});

module.exports = router;

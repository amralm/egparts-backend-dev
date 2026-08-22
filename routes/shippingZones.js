const { apiError } = require('../utils/apiError');
const express = require('express');
const { verifyPermission } = require('../middleware/auth');
const shippingZoneService = require('../services/shippingZoneService');
const logger = require('../utils/logger');
const { validateBody } = require('../middleware/requestValidation');
const { shippingZoneSchema } = require('../schemas/catalogSchemas');

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

router.get('/', verifyPermission('shipping.manage'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    const zones = await shippingZoneService.listZones(storeId);
    res.json({ success: true, zones });
  } catch (err) {
    logger.error('[shipping-zones] list failed:', err.message);
    sendError(res, err);
  }
});

router.post('/', verifyPermission('shipping.manage'), validateBody(shippingZoneSchema), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    const zone = await shippingZoneService.createZone(storeId, req.body || {});
    res.status(201).json({ success: true, zone });
  } catch (err) {
    logger.error('[shipping-zones] create failed:', err.message);
    sendError(res, err);
  }
});

router.put('/:id', verifyPermission('shipping.manage'), validateBody(shippingZoneSchema), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    const zone = await shippingZoneService.updateZone(storeId, req.params.id, req.body || {});
    res.json({ success: true, zone });
  } catch (err) {
    logger.error('[shipping-zones] update failed:', err.message);
    sendError(res, err);
  }
});

router.delete('/:id', verifyPermission('shipping.manage'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    await shippingZoneService.deleteZone(storeId, req.params.id);
    res.json({ success: true });
  } catch (err) {
    logger.error('[shipping-zones] delete failed:', err.message);
    sendError(res, err);
  }
});

module.exports = router;

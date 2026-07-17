const express = require('express');
const { verifyPermission } = require('../middleware/auth');
const shippingZoneService = require('../services/shippingZoneService');
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

router.get('/', verifyPermission('shipping.view'), async (req, res) => {
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

router.post('/', verifyPermission('shipping.manage'), async (req, res) => {
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

router.put('/:id', verifyPermission('shipping.manage'), async (req, res) => {
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

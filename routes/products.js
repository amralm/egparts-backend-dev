const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const publicProductService = require('../services/publicProductService');

function requireStore(req, res) {
  if (!req.store?.id) {
    res.status(400).json({ success: false, code: 'TENANT_CONTEXT_REQUIRED', error: 'Tenant context is required.' });
    return null;
  }
  return req.store.id;
}

router.get('/:id/detail', async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  try {
    const detail = await publicProductService.getProductDetail(storeId, req.params.id, {
      crossSellActive: req.query.cross_sell_active !== 'false',
      crossSellDemo: req.query.cross_sell_demo !== 'false'
    });
    res.json({ success: true, ...detail });
  } catch (err) {
    logger.error('[products] detail failed:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.statusCode === 404 ? 'Product not found' : 'Unable to load product.' });
  }
});

router.post('/:id/reviews', async (req, res) => {
  const storeId = requireStore(req, res);
  if (!storeId) return;

  try {
    const review = await publicProductService.submitReview(storeId, req.params.id, req.body || {});
    res.json({ success: true, review });
  } catch (err) {
    logger.error('[products] review submit failed:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.statusCode === 400 ? 'Invalid review' : 'Unable to submit review.' });
  }
});

module.exports = router;

const { apiError } = require('../utils/apiError');
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const publicProductService = require('../services/publicProductService');

function requireStore(req, res) {
  if (!req.store?.id) {
    apiError(res, 400, 'Tenant context is required.', 'TENANT_CONTEXT_REQUIRED');
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
    apiError(res, err.statusCode || 500, err.statusCode === 404 ? 'Product not found' : 'Unable to load product.', err.statusCode === 404 ? 'PRODUCT_NOT_FOUND' : 'PRODUCT_LOAD_FAILED');
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
    apiError(res, err.statusCode || 500, err.statusCode === 400 ? 'Invalid review' : 'Unable to submit review.', err.statusCode === 400 ? 'INVALID_REVIEW' : 'REVIEW_CREATE_FAILED');
  }
});

module.exports = router;

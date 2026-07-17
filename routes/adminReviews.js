const express = require('express');
const { verifyPermission } = require('../middleware/auth');
const reviewAdminService = require('../services/reviewAdminService');
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

router.get('/', verifyPermission('reviews.view'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    const reviews = await reviewAdminService.listReviews(storeId, req.query.status || 'all');
    res.json({ success: true, reviews });
  } catch (err) {
    logger.error('[admin-reviews] list failed:', err.message);
    sendError(res, err);
  }
});

router.patch('/:id/status', verifyPermission('reviews.manage'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    const review = await reviewAdminService.updateReviewStatus(storeId, req.params.id, req.body?.status);
    res.json({ success: true, review });
  } catch (err) {
    logger.error('[admin-reviews] status update failed:', err.message);
    sendError(res, err);
  }
});

router.delete('/:id', verifyPermission('reviews.manage'), async (req, res) => {
  const storeId = getStoreId(req, res);
  if (!storeId) return;

  try {
    await reviewAdminService.deleteReview(storeId, req.params.id);
    res.json({ success: true });
  } catch (err) {
    logger.error('[admin-reviews] delete failed:', err.message);
    sendError(res, err);
  }
});

module.exports = router;
